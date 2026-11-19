//! Read the active user's Internet Settings, rather than the service WinHTTP defaults.
use super::*;
use windows_sys::Win32::{
    Foundation::{ERROR_FILE_NOT_FOUND, GetLastError, GlobalFree},
    Networking::WinHttp::{
        WINHTTP_CURRENT_USER_IE_PROXY_CONFIG, WinHttpGetIEProxyConfigForCurrentUser,
    },
};

struct Settings(WINHTTP_CURRENT_USER_IE_PROXY_CONFIG);
impl Drop for Settings {
    fn drop(&mut self) {
        unsafe {
            for value in [
                self.0.lpszProxy,
                self.0.lpszProxyBypass,
                self.0.lpszAutoConfigUrl,
            ] {
                if !value.is_null() {
                    GlobalFree(value.cast());
                }
            }
        }
    }
}
unsafe fn text(value: *const u16) -> Result<String, JsError> {
    if value.is_null() {
        return Ok(String::new());
    }
    // Bound OS-provided strings before constructing a slice; no raw settings enter errors.
    for length in 0..32768 {
        if unsafe { *value.add(length) } == 0 {
            return String::from_utf16(unsafe { std::slice::from_raw_parts(value, length) })
                .map_err(|_| unavailable());
        }
    }
    Err(unavailable())
}

pub(super) fn resolve(host: &str, port: u16) -> Result<Option<RedisProxyOptions>, JsError> {
    let mut settings = Settings(unsafe { std::mem::zeroed() });
    unsafe {
        if WinHttpGetIEProxyConfigForCurrentUser(&mut settings.0) == 0 {
            return if GetLastError() == ERROR_FILE_NOT_FOUND {
                Ok(None)
            } else {
                Err(unavailable())
            };
        }
        if bypasses(host, port, &text(settings.0.lpszProxyBypass)?) {
            return Ok(None);
        }
        if settings.0.fAutoDetect != 0 || !text(settings.0.lpszAutoConfigUrl)?.is_empty() {
            return Err(unsupported());
        }
        let list = text(settings.0.lpszProxy)?;
        if list.trim().is_empty() {
            return Ok(None);
        }
        let entries: Vec<_> = list.split([';', ' ']).filter(|s| !s.is_empty()).collect();
        for wanted in ["socks", "http", "https"] {
            for entry in &entries {
                if let Some((protocol, address)) = entry.split_once('=') {
                    if protocol.eq_ignore_ascii_case(wanted) {
                        return from_uri(
                            address,
                            if wanted == "socks" { "socks5" } else { "http" },
                        )
                        .map(Some);
                    }
                }
            }
        }
        if let Some(address) = entries.iter().find(|s| !s.contains('=')) {
            return from_uri(address, "http").map(Some);
        }
        // Only unrelated protocol settings (for example FTP) apply to no TCP tunnel.
        Ok(None)
    }
}
