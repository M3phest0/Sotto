use crate::atomic::write_atomic;
use crate::bytes::ByteMeta;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum BackupReason {
    BeforeWrite,
    Interval,
    EditorClose,
}

impl BackupReason {
    fn label(self) -> &'static str {
        match self {
            BackupReason::BeforeWrite => "before-write",
            BackupReason::Interval => "interval",
            BackupReason::EditorClose => "editor-close",
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupEntry {
    pub file: String,
    pub at_ms: u64,
    pub reason: BackupReason,
    pub hash: String,
    pub size: usize,
    pub encoding: String,
    pub eol: String,
    pub has_bom: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub schema_version: u32,
    pub source: String,
    pub canonical_source: String,
    pub entries: Vec<BackupEntry>,
}

impl Manifest {
    fn new(source: &Path) -> Self {
        let source_text = source.to_string_lossy().into_owned();
        let canonical = source
            .canonicalize()
            .unwrap_or_else(|_| source.to_path_buf())
            .to_string_lossy()
            .into_owned();
        Self {
            schema_version: 1,
            source: source_text,
            canonical_source: canonical,
            entries: Vec::new(),
        }
    }
}

pub fn path_hash(path: &Path) -> String {
    let canonical = path
        .canonicalize()
        .unwrap_or_else(|_| path.to_path_buf())
        .to_string_lossy()
        .trim_end_matches(['/', '\\'])
        .to_lowercase();
    blake3::hash(canonical.as_bytes()).to_hex().to_string()
}

pub fn backup_dir(root: &Path, source: &Path) -> PathBuf {
    root.join(path_hash(source))
}

pub fn create_backup(
    root: &Path,
    source: &Path,
    bytes: &[u8],
    meta: &ByteMeta,
    reason: BackupReason,
    now_ms: u64,
) -> Result<Option<PathBuf>, String> {
    let hash = blake3::hash(bytes).to_hex().to_string();
    let dir = backup_dir(root, source);
    fs::create_dir_all(&dir).map_err(|err| format!("创建备份目录失败: {err}"))?;
    let manifest_path = dir.join("manifest.json");
    let mut manifest = read_manifest(&manifest_path)
        .unwrap_or_else(|_| Manifest::new(source));

    // Same raw bytes as the newest backup: no new entry.
    if manifest.entries.last().map(|entry| entry.hash.as_str()) == Some(hash.as_str()) {
        return Ok(None);
    }

    let file_name = format!(
        "{:013}-{}-{}.md",
        now_ms,
        reason.label(),
        &hash[..8]
    );
    let backup_path = dir.join(&file_name);
    write_atomic(&backup_path, bytes)?;
    manifest.entries.push(BackupEntry {
        file: file_name,
        at_ms: now_ms,
        reason,
        hash,
        size: bytes.len(),
        encoding: format!("{:?}", meta.encoding).to_lowercase(),
        eol: format!("{:?}", meta.eol).to_lowercase(),
        has_bom: meta.has_bom,
    });

    prune(&dir, &mut manifest, now_ms);
    let json = serde_json::to_vec_pretty(&manifest)
        .map_err(|err| format!("序列化备份 manifest 失败: {err}"))?;
    write_atomic(&manifest_path, &json)?;
    Ok(Some(backup_path))
}

fn read_manifest(path: &Path) -> Result<Manifest, String> {
    let bytes = fs::read(path).map_err(|err| format!("读取备份 manifest 失败: {err}"))?;
    serde_json::from_slice(&bytes).map_err(|err| format!("解析备份 manifest 失败: {err}"))
}

fn prune(dir: &Path, manifest: &mut Manifest, now_ms: u64) {
    manifest.entries.sort_by(|a, b| b.at_ms.cmp(&a.at_ms));
    let keep = select_keep(&manifest.entries, now_ms);
    let mut kept = Vec::new();
    for (index, entry) in manifest.entries.iter().enumerate() {
        if keep.contains(&index) {
            kept.push(entry.clone());
        } else {
            let _ = fs::remove_file(dir.join(&entry.file));
        }
    }
    manifest.entries = kept;
}

fn select_keep(entries: &[BackupEntry], now_ms: u64) -> BTreeSet<usize> {
    let mut keep = BTreeSet::new();
    for index in 0..entries.len().min(10) {
        keep.insert(index);
    }

    let mut seen_hours = BTreeSet::new();
    let mut seen_days = BTreeSet::new();
    for (index, entry) in entries.iter().enumerate() {
        let age = now_ms.saturating_sub(entry.at_ms);
        if age <= 24 * 60 * 60 * 1000 && seen_hours.insert(entry.at_ms / 3_600_000) {
            keep.insert(index);
        }
        if age <= 7 * 24 * 60 * 60 * 1000 && seen_days.insert(entry.at_ms / 86_400_000) {
            keep.insert(index);
        }
    }

    keep.into_iter().take(41).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bytes::{decode, ByteMeta};

    fn meta() -> ByteMeta {
        decode(b"x\n").unwrap().meta
    }

    fn dir(label: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "sotto-backup-{label}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn deduplicates_same_raw_bytes() {
        let root = dir("dedupe");
        let source = root.join("a.md");
        fs::write(&source, b"x\n").unwrap();
        let first = create_backup(&root, &source, b"x\n", &meta(), BackupReason::BeforeWrite, 1).unwrap();
        assert!(first.is_some());
        let second = create_backup(&root, &source, b"x\n", &meta(), BackupReason::BeforeWrite, 2).unwrap();
        assert!(second.is_none());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn prunes_to_41_and_keeps_newest_ten() {
        let root = dir("prune");
        let source = root.join("a.md");
        fs::write(&source, b"x\n").unwrap();
        for i in 0..50u64 {
            let body = format!("x{i}\n");
            create_backup(&root, &source, body.as_bytes(), &meta(), BackupReason::Interval, i * 60_000).unwrap();
        }
        let manifest_path = backup_dir(&root, &source).join("manifest.json");
        let manifest: Manifest = serde_json::from_slice(&fs::read(&manifest_path).unwrap()).unwrap();
        assert!(manifest.entries.len() <= 41);
        assert_eq!(manifest.entries.first().unwrap().at_ms, 49 * 60_000);
        let files: Vec<_> = fs::read_dir(backup_dir(&root, &source))
            .unwrap()
            .filter_map(Result::ok)
            .filter(|e| e.file_name() != "manifest.json")
            .collect();
        assert_eq!(files.len(), manifest.entries.len());
        fs::remove_dir_all(root).unwrap();
    }
}
