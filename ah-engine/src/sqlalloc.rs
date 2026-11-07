//! SQLite's allocator. The bundled SQLite calls the C library's `malloc`, whose zones keep freed small blocks resident (about 8
//! MB after a burst, and `malloc_zone_pressure_relief` returns none of it on macOS: measured 0 B released with 16-44 MB held).
//! Routed through the process's global allocator instead (jemalloc, `daemon.malloc_conf`: freed pages go back as they are freed),
//! the burst's pages return to the OS when SQLite frees them. `sqlite3_config(SQLITE_CONFIG_MALLOC)` only works before SQLite
//! initialises, so the daemon calls [`route_through_global_allocator`] once at start, before the first database opens.
use rusqlite::ffi;
use std::alloc::{Layout, alloc, dealloc};
use std::ffi::{c_int, c_void};
use std::sync::atomic::{AtomicBool, Ordering::SeqCst};

/// Bytes in front of every block that hold its size (SQLite asks for the size of a block it holds); 16 keeps the alignment.
const HEADER: usize = 16;

static ROUTED: AtomicBool = AtomicBool::new(false);

fn layout(size: usize) -> Option<Layout> {
    Layout::from_size_align(size.checked_add(HEADER)?, HEADER).ok()
}

unsafe extern "C" fn x_malloc(n: c_int) -> *mut c_void {
    let Some(l) = usize::try_from(n).ok().and_then(layout) else { return std::ptr::null_mut() };
    // SAFETY: `l` has a non-zero size (the header) and a valid alignment.
    let p = unsafe { alloc(l) };
    if p.is_null() {
        return p.cast();
    }
    // SAFETY: `p` is `HEADER + n` bytes, aligned for a `usize`; the size is stored in the header, the block starts after it.
    unsafe {
        p.cast::<usize>().write(n as usize);
        p.add(HEADER).cast()
    }
}

unsafe extern "C" fn x_free(p: *mut c_void) {
    if p.is_null() {
        return;
    }
    // SAFETY: SQLite only frees blocks `x_malloc`/`x_realloc` returned, so the header sits `HEADER` bytes before `p`.
    unsafe {
        let base = p.cast::<u8>().sub(HEADER);
        let n = base.cast::<usize>().read();
        if let Some(l) = layout(n) {
            dealloc(base, l);
        }
    }
}

unsafe extern "C" fn x_size(p: *mut c_void) -> c_int {
    if p.is_null() {
        return 0;
    }
    // SAFETY: as in `x_free`, the header of a block this allocator returned holds its size.
    unsafe { p.cast::<u8>().sub(HEADER).cast::<usize>().read() as c_int }
}

unsafe extern "C" fn x_realloc(p: *mut c_void, n: c_int) -> *mut c_void {
    // SAFETY: `x_malloc`, `x_size` and `x_free` are called with blocks of this allocator, as SQLite does.
    unsafe {
        let new = x_malloc(n);
        if new.is_null() || p.is_null() {
            return new;
        }
        let old = x_size(p) as usize;
        std::ptr::copy_nonoverlapping(p.cast::<u8>(), new.cast::<u8>(), old.min(n.max(0) as usize));
        x_free(p);
        new
    }
}

unsafe extern "C" fn x_roundup(n: c_int) -> c_int {
    (n + 7) & !7
}

unsafe extern "C" fn x_init(_: *mut c_void) -> c_int {
    ffi::SQLITE_OK
}

unsafe extern "C" fn x_shutdown(_: *mut c_void) {}

/// Make SQLite allocate through the global allocator. Must run before SQLite initialises (before any connection opens in this
/// process); returns whether it took effect (`false`: SQLite had already started, it stays on the C library, nothing else changes).
pub fn route_through_global_allocator() -> bool {
    let methods = ffi::sqlite3_mem_methods {
        xMalloc: Some(x_malloc),
        xFree: Some(x_free),
        xRealloc: Some(x_realloc),
        xSize: Some(x_size),
        xRoundup: Some(x_roundup),
        xInit: Some(x_init),
        xShutdown: Some(x_shutdown),
        pAppData: std::ptr::null_mut(),
    };
    // SAFETY: `sqlite3_config` copies the struct before returning; the callbacks above are plain functions valid for the process.
    let rc = unsafe { ffi::sqlite3_config(ffi::SQLITE_CONFIG_MALLOC, &methods as *const ffi::sqlite3_mem_methods) };
    let ok = rc == ffi::SQLITE_OK;
    ROUTED.store(ok, SeqCst);
    ok
}

/// Whether SQLite is routed through the global allocator in this process.
pub fn routed() -> bool {
    ROUTED.load(SeqCst)
}
