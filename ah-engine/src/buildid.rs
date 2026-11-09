//! A binary's build identity: the Mach-O `LC_UUID` or the ELF `NT_GNU_BUILD_ID` note. A burst dump records it so the separate symbol
//! file of that exact build (a dSYM, a debug file) can be found later, and the symbol file itself carries the same id, so a candidate
//! is verified by reading it, never by its name. Only 64-bit little-endian images are read (every target the engine ships); anything
//! else, or a binary linked without the id, yields `None`.
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

const MACHO_MAGIC_64: u32 = 0xfeed_facf;
const LC_UUID: u32 = 0x1b;
const ELF_MAGIC: [u8; 4] = *b"\x7fELF";
const PT_NOTE: u32 = 4;
const NT_GNU_BUILD_ID: u32 = 3;

/// Which kind of identity was found.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// Mach-O `LC_UUID`, shown as `dwarfdump --uuid` shows it.
    MachoUuid,
    /// ELF GNU build-id note, lower-case hex.
    ElfBuildId,
}

impl Kind {
    /// The name written into a dump.
    pub fn name(self) -> &'static str {
        match self {
            Kind::MachoUuid => "macho-uuid",
            Kind::ElfBuildId => "elf-build-id",
        }
    }
}

/// An identity: its kind and text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BuildId {
    /// Where it came from.
    pub kind: Kind,
    /// Upper-case hyphenated UUID (Mach-O) or lower-case hex (ELF).
    pub id: String,
}

/// The identity of the image in `path` (`diagnostics.symbols_read_cap_bytes` bounds what is read of its headers).
pub fn of_file(path: &Path) -> Option<BuildId> {
    let mut f = std::fs::File::open(path).ok()?;
    parse(&mut f, crate::defaults::num("diagnostics.symbols_read_cap_bytes"))
}

/// Normal form for comparing two ids: hex digits only, lower case.
pub fn normalize(id: &str) -> String {
    id.chars().filter(char::is_ascii_hexdigit).map(|c| c.to_ascii_lowercase()).collect()
}

/// The identity of the image `r` reads; at most `cap` bytes of load commands or notes are read (a corrupt size cannot make this
/// allocate without bound).
pub fn parse<R: Read + Seek>(r: &mut R, cap: u64) -> Option<BuildId> {
    let mut head = [0u8; 64];
    r.seek(SeekFrom::Start(0)).ok()?;
    let n = read_up_to(r, &mut head);
    if n >= 32 && u32::from_le_bytes(head[0..4].try_into().ok()?) == MACHO_MAGIC_64 {
        return macho(r, &head, cap);
    }
    if n >= 64 && head[0..4] == ELF_MAGIC && head[4] == 2 && head[5] == 1 {
        return elf(r, &head, cap);
    }
    None
}

fn read_up_to<R: Read>(r: &mut R, buf: &mut [u8]) -> usize {
    let mut got = 0;
    while got < buf.len() {
        let Some(rest) = buf.get_mut(got..) else { break };
        match r.read(rest) {
            Ok(0) | Err(_) => break,
            Ok(n) => got += n,
        }
    }
    got
}

fn u32_at(b: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_le_bytes(b.get(at..at + 4)?.try_into().ok()?))
}

fn u64_at(b: &[u8], at: usize) -> Option<u64> {
    Some(u64::from_le_bytes(b.get(at..at + 8)?.try_into().ok()?))
}

fn u16_at(b: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_le_bytes(b.get(at..at + 2)?.try_into().ok()?))
}

fn macho<R: Read + Seek>(r: &mut R, head: &[u8], cap: u64) -> Option<BuildId> {
    let size = u64::from(u32_at(head, 20)?).min(cap);
    let mut cmds = vec![0u8; size as usize];
    r.seek(SeekFrom::Start(32)).ok()?;
    if read_up_to(r, &mut cmds) < cmds.len() {
        return None;
    }
    let mut at = 0usize;
    for _ in 0..u32_at(head, 16)? {
        let (cmd, len) = (u32_at(&cmds, at)?, u32_at(&cmds, at + 4)? as usize);
        if len < 8 {
            return None;
        }
        if cmd == LC_UUID && len >= 24 {
            let u = cmds.get(at + 8..at + 24)?;
            let part = |r: std::ops::Range<usize>| u.get(r).unwrap_or_default().iter().map(|b| format!("{b:02X}")).collect::<String>();
            return Some(BuildId { kind: Kind::MachoUuid, id: format!("{}-{}-{}-{}-{}", part(0..4), part(4..6), part(6..8), part(8..10), part(10..16)) });
        }
        at += len;
    }
    None
}

fn elf<R: Read + Seek>(r: &mut R, head: &[u8], cap: u64) -> Option<BuildId> {
    let (phoff, phentsize, phnum) = (u64_at(head, 32)?, u64::from(u16_at(head, 54)?), u64::from(u16_at(head, 56)?));
    if phentsize < 56 {
        return None;
    }
    for i in 0..phnum {
        let mut ph = [0u8; 56];
        r.seek(SeekFrom::Start(phoff.checked_add(i * phentsize)?)).ok()?;
        if read_up_to(r, &mut ph) < ph.len() || u32_at(&ph, 0)? != PT_NOTE {
            continue;
        }
        let (off, filesz) = (u64_at(&ph, 8)?, u64_at(&ph, 32)?.min(cap));
        let mut notes = vec![0u8; filesz as usize];
        r.seek(SeekFrom::Start(off)).ok()?;
        if read_up_to(r, &mut notes) < notes.len() {
            continue;
        }
        if let Some(id) = gnu_build_id(&notes) {
            return Some(BuildId { kind: Kind::ElfBuildId, id });
        }
    }
    None
}

fn gnu_build_id(notes: &[u8]) -> Option<String> {
    let pad = |n: usize| (n + 3) & !3;
    let mut at = 0usize;
    while at + 12 <= notes.len() {
        let (namesz, descsz, ty) = (u32_at(notes, at)? as usize, u32_at(notes, at + 4)? as usize, u32_at(notes, at + 8)?);
        let name_at = at + 12;
        let desc_at = name_at + pad(namesz);
        if ty == NT_GNU_BUILD_ID && notes.get(name_at..name_at + namesz) == Some(b"GNU\0") {
            return Some(notes.get(desc_at..desc_at + descsz)?.iter().map(|b| format!("{b:02x}")).collect());
        }
        at = desc_at + pad(descsz);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn parse_t(r: &mut Cursor<Vec<u8>>) -> Option<BuildId> {
        parse(r, 1 << 16)
    }

    fn macho_with(uuid: [u8; 16]) -> Vec<u8> {
        let mut b = vec![0u8; 32];
        b[0..4].copy_from_slice(&MACHO_MAGIC_64.to_le_bytes());
        // two load commands: a 16-byte filler (LC_SEGMENT_64 stand-in), then LC_UUID
        b[16..20].copy_from_slice(&2u32.to_le_bytes());
        b[20..24].copy_from_slice(&(16u32 + 24).to_le_bytes());
        b.extend_from_slice(&0x19u32.to_le_bytes());
        b.extend_from_slice(&16u32.to_le_bytes());
        b.extend_from_slice(&[0u8; 8]);
        b.extend_from_slice(&LC_UUID.to_le_bytes());
        b.extend_from_slice(&24u32.to_le_bytes());
        b.extend_from_slice(&uuid);
        b
    }

    fn elf_with(desc: &[u8]) -> Vec<u8> {
        let mut b = vec![0u8; 64];
        b[0..4].copy_from_slice(&ELF_MAGIC);
        b[4] = 2;
        b[5] = 1;
        b[32..40].copy_from_slice(&64u64.to_le_bytes()); // phoff
        b[54..56].copy_from_slice(&56u16.to_le_bytes());
        b[56..58].copy_from_slice(&2u16.to_le_bytes()); // a PT_LOAD stand-in, then the PT_NOTE
        let note_off = 64 + 2 * 56;
        let mut note = Vec::new();
        note.extend_from_slice(&4u32.to_le_bytes());
        note.extend_from_slice(&(desc.len() as u32).to_le_bytes());
        note.extend_from_slice(&NT_GNU_BUILD_ID.to_le_bytes());
        note.extend_from_slice(b"GNU\0");
        note.extend_from_slice(desc);
        let mut load = [0u8; 56];
        load[0..4].copy_from_slice(&1u32.to_le_bytes());
        let mut ph = [0u8; 56];
        ph[0..4].copy_from_slice(&PT_NOTE.to_le_bytes());
        ph[8..16].copy_from_slice(&(note_off as u64).to_le_bytes());
        ph[32..40].copy_from_slice(&(note.len() as u64).to_le_bytes());
        b.extend_from_slice(&load);
        b.extend_from_slice(&ph);
        b.extend_from_slice(&note);
        b
    }

    #[test]
    fn a_macho_uuid_is_read_as_dwarfdump_prints_it() {
        let id = parse_t(&mut Cursor::new(macho_with(*b"\x01\x23\x45\x67\x89\xab\xcd\xef\x01\x23\x45\x67\x89\xab\xcd\xef"))).expect("uuid");
        assert_eq!((id.kind, id.id.as_str()), (Kind::MachoUuid, "01234567-89AB-CDEF-0123-456789ABCDEF"));
    }

    #[test]
    fn an_elf_gnu_build_id_is_read_as_hex() {
        let id = parse_t(&mut Cursor::new(elf_with(&[0xde, 0xad, 0xbe, 0xef, 0x00, 0x11, 0x22, 0x33]))).expect("build id");
        assert_eq!((id.kind, id.id.as_str()), (Kind::ElfBuildId, "deadbeef00112233"));
    }

    #[test]
    fn anything_else_has_no_identity_and_ids_compare_by_their_digits() {
        assert_eq!(parse_t(&mut Cursor::new(b"not an image".to_vec())), None);
        let mut cut = macho_with([7; 16]);
        cut.truncate(40);
        assert_eq!(parse_t(&mut Cursor::new(cut)), None, "load commands cut short");
        assert_eq!(normalize("01234567-89AB-CDEF-0123-456789ABCDEF"), normalize("0123456789abcdef0123456789abcdef"));
    }

    #[test]
    fn the_running_test_binary_has_an_identity_where_the_platform_links_one() {
        let exe = std::env::current_exe().expect("exe");
        let id = of_file(&exe);
        if cfg!(target_os = "macos") {
            assert!(id.is_some(), "every macOS binary carries an LC_UUID");
        }
    }
}
