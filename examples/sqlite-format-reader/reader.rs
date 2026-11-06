//! A read-only format-two probe. No Mirk or JSON library is linked.
use std::{
    env,
    ffi::{CStr, CString},
    os::raw::{c_char, c_int, c_void},
    ptr, slice,
};

#[link(name = "sqlite3")]
extern "C" {
    fn sqlite3_open_v2(
        path: *const c_char,
        db: *mut *mut c_void,
        flags: c_int,
        vfs: *const c_char,
    ) -> c_int;
    fn sqlite3_close(db: *mut c_void) -> c_int;
    fn sqlite3_errmsg(db: *mut c_void) -> *const c_char;
    fn sqlite3_prepare_v2(
        db: *mut c_void,
        sql: *const c_char,
        size: c_int,
        stmt: *mut *mut c_void,
        tail: *mut *const c_char,
    ) -> c_int;
    fn sqlite3_bind_text(
        stmt: *mut c_void,
        index: c_int,
        value: *const c_char,
        size: c_int,
        destroy: Option<unsafe extern "C" fn(*mut c_void)>,
    ) -> c_int;
    fn sqlite3_step(stmt: *mut c_void) -> c_int;
    fn sqlite3_column_blob(stmt: *mut c_void, column: c_int) -> *const c_void;
    fn sqlite3_column_bytes(stmt: *mut c_void, column: c_int) -> c_int;
    fn sqlite3_finalize(stmt: *mut c_void) -> c_int;
}
struct Database(*mut c_void);
impl Drop for Database {
    fn drop(&mut self) {
        unsafe {
            sqlite3_close(self.0);
        }
    }
}
struct Statement(*mut c_void);
impl Drop for Statement {
    fn drop(&mut self) {
        unsafe {
            sqlite3_finalize(self.0);
        }
    }
}
impl Database {
    fn open(path: &str) -> Result<Self, String> {
        let path = CString::new(path).map_err(|e| e.to_string())?;
        let mut db = ptr::null_mut();
        let code = unsafe { sqlite3_open_v2(path.as_ptr(), &mut db, 1, ptr::null()) }; // SQLITE_OPEN_READONLY
        let owned = Self(db);
        if code != 0 {
            return Err(owned.error());
        }
        Ok(owned)
    }
    fn error(&self) -> String {
        unsafe {
            CStr::from_ptr(sqlite3_errmsg(self.0))
                .to_string_lossy()
                .into_owned()
        }
    }
    fn value(&self, sql: &str, parameters: &[&str]) -> Result<Vec<u8>, String> {
        let sql = CString::new(sql).map_err(|e| e.to_string())?;
        let values: Result<Vec<_>, _> = parameters.iter().map(|s| CString::new(*s)).collect();
        let values = values.map_err(|e| e.to_string())?;
        let mut statement = ptr::null_mut();
        if unsafe { sqlite3_prepare_v2(self.0, sql.as_ptr(), -1, &mut statement, ptr::null_mut()) }
            != 0
        {
            return Err(self.error());
        }
        let statement = Statement(statement);
        for (index, value) in values.iter().enumerate() {
            // SQLITE_STATIC is safe: the owned CStrings outlive this statement.
            if unsafe {
                sqlite3_bind_text(statement.0, (index + 1) as c_int, value.as_ptr(), -1, None)
            } != 0
            {
                return Err(self.error());
            }
        }
        if unsafe { sqlite3_step(statement.0) } != 100 {
            return Err("Expected exactly one non-null row".into());
        }
        let length = unsafe { sqlite3_column_bytes(statement.0, 0) } as usize;
        let data = unsafe { sqlite3_column_blob(statement.0, 0) };
        if data.is_null() {
            return Err("Unexpected SQL NULL".into());
        }
        Ok(unsafe { slice::from_raw_parts(data as *const u8, length).to_vec() })
    }
}
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
fn run() -> Result<(), String> {
    let args: Vec<String> = env::args().collect();
    if args.len() != 5 {
        return Err("usage: reader FILE COLLECTION ID KV_KEY".into());
    }
    let db = Database::open(&args[1])?;
    let marker = db.value(
        "SELECT value FROM _mirk_meta WHERE key='schema_version'",
        &[],
    )?;
    if marker != b"2" {
        return Err(format!(
            "unsupported core format {}; this reader pins 2",
            String::from_utf8_lossy(&marker)
        ));
    }
    // No vector/table interpretation happens before the marker is accepted.
    let blob = db.value(
        "SELECT vec FROM vectors WHERE collection=? AND id=?",
        &[&args[2], &args[3]],
    )?;
    if blob.len() % 4 != 0 {
        return Err("Malformed float32 BLOB length".into());
    }
    let values: Vec<String> = blob
        .chunks_exact(4)
        .map(|b| format!("\"{}\"", f32::from_le_bytes(b.try_into().unwrap())))
        .collect();
    let raw_json = db.value("SELECT value FROM _kv WHERE key=?", &[&args[4]])?;
    // Preserve JSON bytes, including escaped lone UTF-16 surrogates. This probe is not a JSON decoder.
    println!("{{\"format\":2,\"vector_f32_decimal\":[{}],\"vector_le_hex\":\"{}\",\"raw_json_utf8_hex\":\"{}\",\"json_decoded\":false}}", values.join(","), hex(&blob), hex(&raw_json));
    Ok(())
}
fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(2);
    }
}
