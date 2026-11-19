//! Bounded JSON exports through a native, cancellable Save dialog.

use super::*;

pub(super) async fn json(
    content: String,
    file_name: &str,
    maximum: usize,
) -> Result<Option<String>, JsError> {
    if content.len() > maximum {
        return Err(error(
            "PAYLOAD_TOO_LARGE",
            "JSON export exceeds its size limit",
        ));
    }
    let path = pick_save_path(
        nsh_core::file_dialog::SaveDialog::new()
            .file_name(file_name)
            .filter(nsh_core::file_dialog::FileFilter::new("JSON", ["json"])),
    )
    .await
    .map_err(|_| error("EXPORT_FAILED", "Could not open the save dialog"))?;
    let Some(path) = path else { return Ok(None) };
    runtime()?
        .spawn_blocking(move || {
            use std::io::Write;
            let save = || -> std::io::Result<()> {
                let parent = path.parent().ok_or(std::io::ErrorKind::InvalidInput)?;
                let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
                temporary.write_all(content.as_bytes())?;
                temporary.as_file().sync_all()?;
                temporary.persist(&path).map_err(|cause| cause.error)?;
                Ok(())
            };
            save().map_err(|_| error("EXPORT_FAILED", "Could not save the JSON report"))?;
            Ok(Some(path.to_string_lossy().to_string()))
        })
        .await
        .map_err(|_| error("EXPORT_FAILED", "Could not save the JSON report"))?
}
