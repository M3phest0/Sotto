use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

fn temp_path(target: &Path) -> PathBuf {
    let parent = target.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or(Path::new("."));
    let name = target
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "file".into());
    let seq = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    parent.join(format!(
        ".{name}.sotto-{}-{seq}.tmp",
        std::process::id()
    ))
}

/// Write bytes to a same-directory temp file, fsync, then replace the target.
/// Windows uses ReplaceFileW first (preserves ACL/attributes), MoveFileEx as
/// fallback; other platforms use rename. The original file is untouched on
/// any failure before the replace step.
pub fn write_atomic(target: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = target.parent().filter(|p| !p.as_os_str().is_empty());
    if let Some(parent) = parent {
        fs::create_dir_all(parent).map_err(|err| format!("创建目录失败: {err}"))?;
    }

    let mut last_error = String::new();
    for attempt in 0..3 {
        let temp = temp_path(target);
        let result = (|| -> Result<(), String> {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temp)
                .map_err(|err| format!("创建临时文件失败: {err}"))?;
            file.write_all(bytes)
                .map_err(|err| format!("写入临时文件失败: {err}"))?;
            file.sync_all()
                .map_err(|err| format!("同步临时文件失败: {err}"))?;
            drop(file);
            replace_file(&temp, target).map_err(|err| format!("替换目标文件失败: {err}"))?;
            Ok(())
        })();

        match result {
            Ok(()) => return Ok(()),
            Err(err) => {
                let _ = fs::remove_file(&temp);
                last_error = err;
                if attempt < 2 {
                    std::thread::sleep(Duration::from_millis(50 * (1 << attempt)));
                }
            }
        }
    }
    Err(format!(
        "原子写入失败（已保留原文件）: {last_error}"
    ))
}

#[cfg(windows)]
fn replace_file(temp: &Path, target: &Path) -> io::Result<()> {
    use std::ffi::c_void;
    use std::os::windows::ffi::OsStrExt;

    const REPLACEFILE_WRITE_THROUGH: u32 = 0x0000_0001;
    const MOVEFILE_REPLACE_EXISTING: u32 = 0x0000_0001;
    const MOVEFILE_WRITE_THROUGH: u32 = 0x0000_0008;

    unsafe extern "system" {
        fn ReplaceFileW(
            replaced: *const u16,
            replacement: *const u16,
            backup: *const u16,
            flags: u32,
            exclude: *mut c_void,
            reserved: *mut c_void,
        ) -> i32;
        fn MoveFileExW(existing: *const u16, new_name: *const u16, flags: u32) -> i32;
    }

    fn wide(path: &Path) -> Vec<u16> {
        path.as_os_str().encode_wide().chain(std::iter::once(0)).collect()
    }

    let temp = wide(temp);
    let target = wide(target);
    let target_exists = target.len() > 1;

    unsafe {
        if target_exists {
            let ok = ReplaceFileW(
                target.as_ptr(),
                temp.as_ptr(),
                std::ptr::null(),
                REPLACEFILE_WRITE_THROUGH,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            );
            if ok != 0 {
                return Ok(());
            }
        }
        let flags = MOVEFILE_WRITE_THROUGH
            | if target_exists { MOVEFILE_REPLACE_EXISTING } else { 0 };
        let ok = MoveFileExW(temp.as_ptr(), target.as_ptr(), flags);
        if ok != 0 {
            Ok(())
        } else {
            Err(io::Error::last_os_error())
        }
    }
}

#[cfg(not(windows))]
fn replace_file(temp: &Path, target: &Path) -> io::Result<()> {
    fs::rename(temp, target)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "sotto-atomic-{label}-{}-{}",
            std::process::id(),
            TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn writes_new_and_overwrites_existing() {
        let dir = temp_dir("write");
        let target = dir.join("a.md");
        write_atomic(&target, b"one").unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"one");
        write_atomic(&target, b"two").unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"two");
        let leftovers: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().contains(".sotto-"))
            .collect();
        assert!(leftovers.is_empty(), "temp files left: {leftovers:?}");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn creates_missing_parent_directories() {
        let dir = temp_dir("parent");
        let target = dir.join("nested").join("a.md");
        write_atomic(&target, b"x").unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"x");
        fs::remove_dir_all(dir).unwrap();
    }
}
