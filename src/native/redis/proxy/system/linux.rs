//! Environment proxy settings, followed by GNOME's session configuration.
use super::*;
use std::{collections::HashMap, process::Stdio};

fn environment(names: &[&str]) -> Option<String> {
    names
        .iter()
        .find_map(|key| std::env::var(key).ok().filter(|s| !s.is_empty()))
}

pub(super) async fn resolve(host: &str, port: u16) -> Result<Option<RedisProxyOptions>, JsError> {
    if environment(&["no_proxy", "NO_PROXY"]).is_some_and(|rules| bypasses(host, port, &rules)) {
        return Ok(None);
    }
    if let Some(value) = environment(&[
        "all_proxy",
        "ALL_PROXY",
        "http_proxy",
        "HTTP_PROXY",
        "https_proxy",
        "HTTPS_PROXY",
    ]) {
        return from_uri(&value, "http").map(Some);
    }
    let mut command = tokio::process::Command::new("gsettings");
    command
        .args(["list-recursively", "org.gnome.system.proxy"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(unavailable()),
    };
    let mut bytes = Vec::new();
    child
        .stdout
        .take()
        .ok_or_else(unavailable)?
        .take(65537)
        .read_to_end(&mut bytes)
        .await
        .map_err(|_| unavailable())?;
    if bytes.len() > 65536 {
        return Err(unavailable());
    }
    if !child.wait().await.map_err(|_| unavailable())?.success() {
        return if environment(&["XDG_CURRENT_DESKTOP"])
            .is_some_and(|desktop| desktop.to_ascii_lowercase().contains("gnome"))
        {
            Err(unavailable())
        } else {
            Ok(None)
        };
    }
    let output = std::str::from_utf8(&bytes).map_err(|_| unavailable())?;
    let mut settings = HashMap::new();
    for line in output.lines() {
        let mut parts = line.splitn(3, ' ');
        if let (Some(schema), Some(key), Some(value)) = (parts.next(), parts.next(), parts.next()) {
            settings.insert(format!("{schema}.{key}"), value.trim());
        }
    }
    let get = |key: &str| settings.get(key).copied().unwrap_or("");
    match unquote(get("org.gnome.system.proxy.mode"))?.as_str() {
        "none" => return Ok(None),
        "manual" => (),
        "auto" => return Err(unsupported()),
        _ => return Err(unavailable()),
    }
    let exclusions = get("org.gnome.system.proxy.ignore-hosts");
    // GSettings string arrays contain quoted patterns; each pattern is evaluated separately.
    for pattern in exclusions
        .trim_start_matches("@as ")
        .trim_matches(['[', ']'])
        .split(',')
        .filter(|p| !p.trim().is_empty())
    {
        if bypasses(host, port, &unquote(pattern.trim())?) {
            return Ok(None);
        }
    }
    for (schema, kind) in [("socks", "socks5"), ("http", "http"), ("https", "http")] {
        let prefix = format!("org.gnome.system.proxy.{schema}");
        let proxy_host = unquote(get(&format!("{prefix}.host")))?;
        if proxy_host.is_empty() {
            continue;
        }
        let port = get(&format!("{prefix}.port"))
            .parse()
            .map_err(|_| unsupported())?;
        let mut proxy = endpoint(kind, proxy_host, port)?;
        if schema == "http" && get(&format!("{prefix}.use-authentication")) == "true" {
            proxy.username = Some(unquote(get(&format!("{prefix}.authentication-user")))?);
            proxy.password = Some(unquote(get(&format!("{prefix}.authentication-password")))?);
            proxy.validate().map_err(|_| unsupported())?;
        }
        return Ok(Some(proxy));
    }
    Ok(None)
}

fn unquote(value: &str) -> Result<String, JsError> {
    if value.is_empty() {
        return Ok(String::new());
    }
    let quote = value.chars().next().unwrap();
    if !matches!(quote, '\'' | '"') || !value.ends_with(quote) || value.len() < 2 {
        return Err(unavailable());
    }
    let mut text = String::new();
    let mut escaped = false;
    for character in value[1..value.len() - 1].chars() {
        if escaped {
            text.push(match character {
                'n' => '\n',
                'r' => '\r',
                't' => '\t',
                '\\' => '\\',
                '\'' => '\'',
                '"' => '"',
                _ => return Err(unsupported()),
            });
            escaped = false;
        } else if character == '\\' {
            escaped = true;
        } else {
            text.push(character);
        }
    }
    if escaped {
        return Err(unavailable());
    }
    Ok(text)
}
