use encoding_rs::GB18030;
use serde::Serialize;

const BOM_UTF8: [u8; 3] = [0xEF, 0xBB, 0xBF];
const BOM_UTF16_LE: [u8; 2] = [0xFF, 0xFE];
const BOM_UTF16_BE: [u8; 2] = [0xFE, 0xFF];

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub enum Encoding {
    #[serde(rename = "utf-8")]
    Utf8,
    #[serde(rename = "utf-16le")]
    Utf16Le,
    #[serde(rename = "utf-16be")]
    Utf16Be,
    #[serde(rename = "gbk")]
    Gbk,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub enum Eol {
    #[serde(rename = "crlf")]
    Crlf,
    #[serde(rename = "lf")]
    Lf,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ByteMeta {
    pub encoding: Encoding,
    pub has_bom: bool,
    pub eol: Eol,
    pub mixed_eol: bool,
    pub trailing_newline: bool,
    pub hash: String,
    pub size: usize,
    pub line_count: usize,
}

#[derive(Clone, Debug)]
pub struct DecodedFile {
    pub text: String,
    pub meta: ByteMeta,
    pub read_only_reason: Option<String>,
}

pub fn decode(bytes: &[u8]) -> Result<DecodedFile, String> {
    let hash = blake3::hash(bytes).to_hex().to_string();
    let size = bytes.len();

    if bytes.starts_with(&BOM_UTF8) {
        let body = &bytes[BOM_UTF8.len()..];
        let text = std::str::from_utf8(body)
            .map_err(|err| format!("UTF-8 BOM 文件解码失败: {err}"))?;
        return Ok(make_decoded(text.to_string(), Encoding::Utf8, true, None, hash, size));
    }

    if bytes.starts_with(&BOM_UTF16_LE) {
        let text = decode_utf16(&bytes[BOM_UTF16_LE.len()..], true)?;
        return Ok(make_decoded(
            text,
            Encoding::Utf16Le,
            true,
            Some("UTF-16 LE 文件只读展示；请另存为 UTF-8".into()),
            hash,
            size,
        ));
    }

    if bytes.starts_with(&BOM_UTF16_BE) {
        let text = decode_utf16(&bytes[BOM_UTF16_BE.len()..], false)?;
        return Ok(make_decoded(
            text,
            Encoding::Utf16Be,
            true,
            Some("UTF-16 BE 文件只读展示；请另存为 UTF-8".into()),
            hash,
            size,
        ));
    }

    if let Ok(text) = std::str::from_utf8(bytes) {
        return Ok(make_decoded(text.to_string(), Encoding::Utf8, false, None, hash, size));
    }

    let (text, had_errors) = GB18030.decode_without_bom_handling(bytes);
    if !had_errors && !text.contains('\u{FFFD}') {
        return Ok(make_decoded(
            text.into_owned(),
            Encoding::Gbk,
            false,
            Some("GBK/GB18030 文件只读展示；请另存为 UTF-8".into()),
            hash,
            size,
        ));
    }

    Err("无法可靠解码文件；未写入磁盘".into())
}

fn decode_utf16(bytes: &[u8], little_endian: bool) -> Result<String, String> {
    if bytes.len() % 2 != 0 {
        return Err("UTF-16 文件字节数为奇数".into());
    }
    let units: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|pair| {
            if little_endian {
                u16::from_le_bytes([pair[0], pair[1]])
            } else {
                u16::from_be_bytes([pair[0], pair[1]])
            }
        })
        .collect();
    String::from_utf16(&units)
        .map(|text| normalize_to_lf(&text))
        .map_err(|err| format!("UTF-16 解码失败: {err}"))
}

fn make_decoded(
    raw_text: String,
    encoding: Encoding,
    has_bom: bool,
    read_only_reason: Option<String>,
    hash: String,
    size: usize,
) -> DecodedFile {
    let eol = detect_eol(&raw_text);
    let mixed_eol = is_mixed_eol(&raw_text);
    let trailing_newline = raw_text.ends_with('\n') || raw_text.ends_with('\r');
    let text = normalize_to_lf(&raw_text);
    let line_count = text.lines().count();
    DecodedFile {
        text,
        meta: ByteMeta {
            encoding,
            has_bom,
            eol,
            mixed_eol,
            trailing_newline,
            hash,
            size,
            line_count,
        },
        read_only_reason,
    }
}

pub fn normalize_to_lf(text: &str) -> String {
    text.replace("\r\n", "\n").replace('\r', "\n")
}

pub fn detect_eol(text: &str) -> Eol {
    let crlf = text.matches("\r\n").count();
    let total_lf = text.matches('\n').count();
    let bare_lf = total_lf.saturating_sub(crlf);
    if bare_lf > crlf {
        Eol::Lf
    } else {
        Eol::Crlf
    }
}

/// Both CRLF and bare LF present. Saves normalize to the majority EOL; the
/// frontend surfaces a one-time notice before that happens.
pub fn is_mixed_eol(text: &str) -> bool {
    let crlf = text.matches("\r\n").count();
    let total_lf = text.matches('\n').count();
    crlf > 0 && total_lf > crlf
}

/// Convert the editor's LF text back to the existing file's EOL/BOM.
/// The caller owns trailing-newline policy; this function does not add or
/// remove blank lines.
pub fn encode_existing(text_lf: &str, meta: &ByteMeta) -> Result<Vec<u8>, String> {
    if meta.encoding != Encoding::Utf8 {
        return Err("该文件编码只读；请另存为 UTF-8".into());
    }
    let text = normalize_to_lf(text_lf);
    let text = match meta.eol {
        Eol::Lf => text,
        Eol::Crlf => text.replace('\n', "\r\n"),
    };
    let mut bytes = Vec::with_capacity(text.len() + 3);
    if meta.has_bom {
        bytes.extend_from_slice(&BOM_UTF8);
    }
    bytes.extend_from_slice(text.as_bytes());
    Ok(bytes)
}

/// New files: UTF-8 without BOM, CRLF, exactly one trailing newline.
pub fn encode_new(text_lf: &str) -> Vec<u8> {
    let mut text = normalize_to_lf(text_lf);
    while text.ends_with('\n') {
        text.pop();
    }
    text.push('\n');
    text.replace('\n', "\r\n").into_bytes()
}

pub fn text_hash(bytes: &[u8]) -> String {
    blake3::hash(bytes).to_hex().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn utf16le(text: &str) -> Vec<u8> {
        let mut bytes = BOM_UTF16_LE.to_vec();
        for unit in text.encode_utf16() {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
        bytes
    }

    #[test]
    fn crlf_roundtrip_preserves_bom_eol_and_trailing() {
        let raw = b"\xEF\xBB\xBF# t\r\n\r\n- [ ] a\r\n";
        let decoded = decode(raw).unwrap();
        assert_eq!(decoded.text, "# t\n\n- [ ] a\n");
        assert_eq!(decoded.meta.encoding, Encoding::Utf8);
        assert!(decoded.meta.has_bom);
        assert_eq!(decoded.meta.eol, Eol::Crlf);
        assert!(!decoded.meta.mixed_eol);
        assert!(decoded.meta.trailing_newline);
        assert_eq!(decoded.meta.line_count, 3);
        assert_eq!(encode_existing(&decoded.text, &decoded.meta).unwrap(), raw);
    }

    #[test]
    fn lf_no_trailing_is_preserved() {
        let raw = b"# t\n\n- [x] a";
        let decoded = decode(raw).unwrap();
        assert_eq!(decoded.text, "# t\n\n- [x] a");
        assert_eq!(decoded.meta.eol, Eol::Lf);
        assert!(!decoded.meta.trailing_newline);
        assert_eq!(encode_existing(&decoded.text, &decoded.meta).unwrap(), raw);
    }

    #[test]
    fn mixed_eol_uses_majority_and_normalizes_on_save() {
        let raw = b"a\r\nb\r\nc\n";
        let decoded = decode(raw).unwrap();
        assert_eq!(decoded.meta.eol, Eol::Crlf);
        assert!(decoded.meta.mixed_eol);
        assert_eq!(decoded.text, "a\nb\nc\n");
        assert_eq!(
            encode_existing(&decoded.text, &decoded.meta).unwrap(),
            b"a\r\nb\r\nc\r\n"
        );
    }

    #[test]
    fn mixed_eol_tie_prefers_crlf() {
        assert_eq!(detect_eol("a\r\nb\n"), Eol::Crlf);
        assert_eq!(detect_eol("a\nb\nc\r\n"), Eol::Lf);
    }

    #[test]
    fn utf16_is_read_only_but_decodes() {
        let raw = utf16le("中文\r\n- [ ] a\r\n");
        let decoded = decode(&raw).unwrap();
        assert_eq!(decoded.text, "中文\n- [ ] a\n");
        assert_eq!(decoded.meta.encoding, Encoding::Utf16Le);
        assert!(decoded.read_only_reason.is_some());
        assert!(encode_existing(&decoded.text, &decoded.meta).is_err());
    }

    #[test]
    fn gbk_is_read_only() {
        let raw = [0xD6, 0xD0, 0xCE, 0xC4];
        let decoded = decode(&raw).unwrap();
        assert_eq!(decoded.text, "中文");
        assert_eq!(decoded.meta.encoding, Encoding::Gbk);
        assert!(decoded.read_only_reason.is_some());
        assert!(encode_existing(&decoded.text, &decoded.meta).is_err());
    }

    #[test]
    fn invalid_bytes_are_rejected() {
        assert!(decode(&[0x81]).is_err());
    }

    #[test]
    fn hash_is_over_raw_bytes() {
        let lf = decode(b"a\n").unwrap();
        let crlf = decode(b"a\r\n").unwrap();
        assert_eq!(lf.text, crlf.text);
        assert_ne!(lf.meta.hash, crlf.meta.hash);
        assert_eq!(lf.meta.hash, text_hash(b"a\n"));
    }

    #[test]
    fn new_file_is_utf8_no_bom_crlf_one_trailing() {
        let bytes = encode_new("# t\n\n- [ ] a\n\n");
        assert_eq!(bytes, b"# t\r\n\r\n- [ ] a\r\n");
        let decoded = decode(&bytes).unwrap();
        assert_eq!(decoded.meta.encoding, Encoding::Utf8);
        assert!(!decoded.meta.has_bom);
        assert_eq!(decoded.meta.eol, Eol::Crlf);
        assert!(decoded.meta.trailing_newline);
    }

    #[test]
    fn line_count_and_trailing_flags() {
        let decoded = decode(b"a\n\n").unwrap();
        assert_eq!(decoded.meta.line_count, 2);
        assert!(decoded.meta.trailing_newline);
        let empty = decode(b"").unwrap();
        assert_eq!(empty.meta.line_count, 0);
        assert!(!empty.meta.trailing_newline);
    }
}
