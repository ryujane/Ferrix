//! CFNetwork applies active-network settings and the system's host exclusions.
use super::*;
use core_foundation::{
    array::{CFArray, CFArrayRef},
    base::{CFType, TCFType},
    dictionary::{CFDictionary, CFDictionaryRef},
    number::CFNumber,
    string::{CFString, CFStringRef},
    url::{CFURL, CFURLCreateWithString},
};

#[link(name = "CFNetwork", kind = "framework")]
unsafe extern "C" {
    fn CFNetworkCopySystemProxySettings() -> CFDictionaryRef;
    fn CFNetworkCopyProxiesForURL(
        url: core_foundation::url::CFURLRef,
        settings: CFDictionaryRef,
    ) -> CFArrayRef;
    static kCFProxyTypeKey: CFStringRef;
    static kCFProxyTypeNone: CFStringRef;
    static kCFProxyTypeSOCKS: CFStringRef;
    static kCFProxyTypeHTTP: CFStringRef;
    static kCFProxyTypeHTTPS: CFStringRef;
    static kCFProxyHostNameKey: CFStringRef;
    static kCFProxyPortNumberKey: CFStringRef;
    static kCFProxyUsernameKey: CFStringRef;
    static kCFProxyPasswordKey: CFStringRef;
}

fn field(dict: &CFDictionary<CFString, CFType>, key: CFStringRef) -> Option<CFType> {
    let key = unsafe { CFString::wrap_under_get_rule(key) };
    dict.find(&key).map(|v| (*v).clone())
}

pub(super) fn resolve(host: &str, port: u16) -> Result<Option<RedisProxyOptions>, JsError> {
    let host = if host.contains(':') {
        format!("[{host}]")
    } else {
        host.to_owned()
    };
    // TCP tunnels use the system HTTP route; the requested port remains the Redis/SSH port.
    // SAFETY: Copy APIs return retained CF objects. Wrappers release them on every exit.
    unsafe {
        let address = CFString::new(&format!("http://{host}:{port}/"));
        let url = CFURLCreateWithString(
            std::ptr::null(),
            address.as_concrete_TypeRef(),
            std::ptr::null(),
        );
        if url.is_null() {
            return Err(unavailable());
        }
        let url = CFURL::wrap_under_create_rule(url);
        let settings = CFNetworkCopySystemProxySettings();
        if settings.is_null() {
            return Err(unavailable());
        }
        let settings = CFDictionary::<CFString, CFType>::wrap_under_create_rule(settings);
        let proxies =
            CFNetworkCopyProxiesForURL(url.as_concrete_TypeRef(), settings.as_concrete_TypeRef());
        if proxies.is_null() {
            return Err(unavailable());
        }
        let proxies = CFArray::<CFType>::wrap_under_create_rule(proxies);
        let first = proxies.get(0).ok_or_else(unavailable)?;
        let dict = first.downcast::<CFDictionary>().ok_or_else(unavailable)?;
        let dict =
            CFDictionary::<CFString, CFType>::wrap_under_get_rule(dict.as_concrete_TypeRef());
        let kind = field(&dict, kCFProxyTypeKey)
            .and_then(|v| v.downcast::<CFString>())
            .ok_or_else(unavailable)?;
        if kind.as_concrete_TypeRef() == kCFProxyTypeNone
            || kind == CFString::wrap_under_get_rule(kCFProxyTypeNone)
        {
            return Ok(None);
        }
        let kind = if kind == CFString::wrap_under_get_rule(kCFProxyTypeSOCKS) {
            "socks5"
        } else if kind == CFString::wrap_under_get_rule(kCFProxyTypeHTTP)
            || kind == CFString::wrap_under_get_rule(kCFProxyTypeHTTPS)
        {
            "http"
        }
        // PAC/WPAD require script evaluation; never silently turn an unresolved route into DIRECT.
        else {
            return Err(unsupported());
        };
        let host = field(&dict, kCFProxyHostNameKey)
            .and_then(|v| v.downcast::<CFString>())
            .ok_or_else(unavailable)?
            .to_string();
        let port = field(&dict, kCFProxyPortNumberKey)
            .and_then(|v| v.downcast::<CFNumber>())
            .and_then(|n| n.to_i64())
            .and_then(|n| u32::try_from(n).ok())
            .ok_or_else(unavailable)?;
        let mut proxy = endpoint(kind, host, port)?;
        proxy.username = field(&dict, kCFProxyUsernameKey)
            .and_then(|v| v.downcast::<CFString>())
            .map(|v| v.to_string())
            .filter(|s| !s.is_empty());
        proxy.password = field(&dict, kCFProxyPasswordKey)
            .and_then(|v| v.downcast::<CFString>())
            .map(|v| v.to_string())
            .filter(|s| !s.is_empty());
        proxy.validate().map_err(|_| unsupported())?;
        Ok(Some(proxy))
    }
}
