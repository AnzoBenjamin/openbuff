//! Versioned local repository storage service. The writer is shared across CLI sessions.
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::Deserialize;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const VERSION: u32 = 1;
const MAX_MESSAGE: usize = 32 * 1024 * 1024;
const MAX_BATCH: usize = 100_000;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Scope {
    repository_id: String,
    worktree_id: String,
}
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct Key {
    scope: Scope,
    table: String,
    key: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Put {
    scope: Scope,
    table: String,
    key: String,
    value: Value,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Check {
    scope: Scope,
    table: String,
    key: String,
    expected_version: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Batch {
    #[serde(default)]
    checks: Vec<Check>,
    #[serde(default)]
    puts: Vec<Put>,
    #[serde(default)]
    deletes: Vec<Key>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Query {
    scope: Scope,
    table: String,
    prefix: Option<String>,
    after: Option<String>,
    keys: Option<Vec<String>>,
    limit: Option<usize>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    id: String,
    protocol_version: u32,
    method: String,
    #[serde(default)]
    params: Value,
}

fn valid_scope(scope: &Scope) -> Result<(), String> {
    if scope.repository_id.is_empty()
        || scope.worktree_id.is_empty()
        || scope.repository_id.len() > 256
        || scope.worktree_id.len() > 256
    {
        return Err("Invalid repository scope".into());
    }
    Ok(())
}
fn valid_key(scope: &Scope, table: &str, key: &str) -> Result<(), String> {
    valid_scope(scope)?;
    if table.is_empty()
        || table.len() > 128
        || !table
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c))
        || key.is_empty()
        || key.len() > 8192
    {
        return Err("Invalid storage key".into());
    }
    Ok(())
}
fn open(directory: &Path) -> Result<Connection, String> {
    std::fs::create_dir_all(directory).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let metadata = std::fs::symlink_metadata(directory).map_err(|e| e.to_string())?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err("Storage must be a real private directory".into());
        }
        std::fs::set_permissions(directory, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| e.to_string())?;
    }
    let file = directory.join("repository.sqlite");
    if let Ok(meta) = std::fs::symlink_metadata(&file) {
        if !meta.is_file() || meta.file_type().is_symlink() {
            return Err("Unsafe storage file".into());
        }
    }
    let db = Connection::open(&file).map_err(|e| e.to_string())?;
    db.busy_timeout(Duration::from_secs(10))
        .map_err(|e| e.to_string())?;
    db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS records(repository TEXT NOT NULL,worktree TEXT NOT NULL,kind TEXT NOT NULL,key TEXT NOT NULL,version TEXT NOT NULL,value TEXT NOT NULL CHECK(json_valid(value)),PRIMARY KEY(repository,worktree,kind,key)) WITHOUT ROWID; CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value INTEGER NOT NULL) WITHOUT ROWID; INSERT OR IGNORE INTO metadata VALUES('sequence',0),('transactions',0),('writes',0);").map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600))
            .map_err(|e| e.to_string())?;
    }
    Ok(db)
}
fn get(db: &Connection, key: &Key) -> Result<Value, String> {
    valid_key(&key.scope, &key.table, &key.key)?;
    let row: Option<(String,String)> = db.query_row("SELECT version,value FROM records WHERE repository=?1 AND worktree=?2 AND kind=?3 AND key=?4", params![key.scope.repository_id,key.scope.worktree_id,key.table,key.key], |row| Ok((row.get(0)?,row.get(1)?))).optional().map_err(|e| e.to_string())?;
    match row {
        None => Ok(Value::Null),
        Some((version, body)) => Ok(
            json!({"key":key.key,"version":version,"value":serde_json::from_str::<Value>(&body).map_err(|e| e.to_string())?}),
        ),
    }
}
fn batch(db: &mut Connection, input: Batch) -> Result<Value, String> {
    if input.checks.len() + input.puts.len() + input.deletes.len() > MAX_BATCH {
        return Err("Batch budget exceeded".into());
    }
    for c in &input.checks {
        valid_key(&c.scope, &c.table, &c.key)?;
    }
    for p in &input.puts {
        valid_key(&p.scope, &p.table, &p.key)?;
    }
    for d in &input.deletes {
        valid_key(&d.scope, &d.table, &d.key)?;
    }
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    for check in &input.checks {
        let actual: Option<String>=tx.query_row("SELECT version FROM records WHERE repository=?1 AND worktree=?2 AND kind=?3 AND key=?4",params![check.scope.repository_id,check.scope.worktree_id,check.table,check.key],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
        if actual != check.expected_version {
            return Ok(json!({"committed":false,"writes":0,"versions":[]}));
        }
    }
    let mut sequence: i64 = tx
        .query_row("SELECT value FROM metadata WHERE key='sequence'", [], |r| {
            r.get(0)
        })
        .map_err(|e| e.to_string())?;
    let mut versions = Vec::new();
    let mut writes = 0;
    for put in input.puts {
        sequence = sequence.checked_add(1).ok_or("Sequence exhausted")?;
        let version = format!("rust-{}", sequence);
        tx.execute("INSERT INTO records VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(repository,worktree,kind,key) DO UPDATE SET version=excluded.version,value=excluded.value",params![put.scope.repository_id,put.scope.worktree_id,put.table,put.key,version,put.value.to_string()]).map_err(|e|e.to_string())?;
        versions.push(json!({"scope":{"repositoryId":put.scope.repository_id,"worktreeId":put.scope.worktree_id},"table":put.table,"key":put.key,"version":version}));
        writes += 1;
    }
    for key in input.deletes {
        writes += tx
            .execute(
                "DELETE FROM records WHERE repository=?1 AND worktree=?2 AND kind=?3 AND key=?4",
                params![
                    key.scope.repository_id,
                    key.scope.worktree_id,
                    key.table,
                    key.key
                ],
            )
            .map_err(|e| e.to_string())?;
    }
    tx.execute(
        "UPDATE metadata SET value=?1 WHERE key='sequence'",
        [sequence],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "UPDATE metadata SET value=value+1 WHERE key='transactions'",
        [],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "UPDATE metadata SET value=value+?1 WHERE key='writes'",
        [writes as i64],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(json!({"committed":true,"writes":writes,"versions":versions}))
}
fn query(db: &Connection, request: Query) -> Result<Value, String> {
    valid_scope(&request.scope)?;
    valid_key(&request.scope, &request.table, "query")?;
    let limit = request.limit.unwrap_or(512).clamp(1, 4096);
    if request.keys.as_ref().is_some_and(|k| k.len() > 4096) {
        return Err("Key filter budget exceeded".into());
    }
    // Range predicates are indexed. Explicit key filters use direct indexed lookups.
    let mut records = Vec::new();
    let prefix = request.prefix.unwrap_or_default();
    let after = request.after.unwrap_or_default();
    if let Some(mut keys) = request.keys {
        keys.sort();
        keys.dedup();
        for key in keys
            .into_iter()
            .filter(|key| key > &after && key.starts_with(&prefix))
        {
            let result = get(
                db,
                &Key {
                    scope: request.scope.clone(),
                    table: request.table.clone(),
                    key,
                },
            )?;
            if !result.is_null() {
                records.push(result);
                if records.len() > limit {
                    break;
                }
            }
        }
    } else {
        let mut upper_prefix = prefix.clone();
        let upper = loop {
            let Some(last) = upper_prefix.pop() else {
                break None;
            };
            if last != '\u{10ffff}' {
                let next = if last == '\u{d7ff}' {
                    '\u{e000}'
                } else {
                    char::from_u32(last as u32 + 1).ok_or("Invalid key prefix")?
                };
                upper_prefix.push(next);
                break Some(upper_prefix);
            }
        };
        let mut statement=db.prepare("SELECT key,version,value FROM records WHERE repository=?1 AND worktree=?2 AND kind=?3 AND key>?4 AND key>=?5 AND (?6 IS NULL OR key<?6) ORDER BY key LIMIT ?7").map_err(|e|e.to_string())?;
        let rows = statement
            .query_map(
                params![
                    request.scope.repository_id,
                    request.scope.worktree_id,
                    request.table,
                    after,
                    prefix,
                    upper,
                    (limit + 1) as i64
                ],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                    ))
                },
            )
            .map_err(|e| e.to_string())?;
        for row in rows {
            let (key, version, body) = row.map_err(|e| e.to_string())?;
            records.push(json!({"key":key,"version":version,"value":serde_json::from_str::<Value>(&body).map_err(|e|e.to_string())?}));
        }
    }
    let cursor = if records.len() > limit {
        records.truncate(limit);
        records.last().and_then(|r| r.get("key")).cloned()
    } else {
        None
    };
    Ok(match cursor {
        Some(cursor) => json!({"records":records,"cursor":cursor}),
        None => json!({"records":records}),
    })
}
fn dispatch(db: &mut Connection, method: &str, input: Value) -> Result<Value, String> {
    match method {
        "hello" => Ok(
            json!({"protocolVersion":VERSION,"backend":"rust-sqlite","capabilities":["atomic-cas","pagination","shared-objects","durable-journal"]}),
        ),
        "get" => get(
            db,
            &serde_json::from_value(input).map_err(|e| e.to_string())?,
        ),
        "query" => query(
            db,
            serde_json::from_value(input).map_err(|e| e.to_string())?,
        ),
        "batch" => batch(
            db,
            serde_json::from_value(input).map_err(|e| e.to_string())?,
        ),
        "stats" => {
            let scope = input
                .get("scope")
                .map(|v| serde_json::from_value::<Scope>(v.clone()))
                .transpose()
                .map_err(|e| e.to_string())?;
            let (records, bytes): (i64, i64) = if let Some(scope) = scope {
                valid_scope(&scope)?;
                db.query_row("SELECT count(*),coalesce(sum(length(CAST(value AS BLOB))),0) FROM records WHERE repository=?1 AND worktree=?2",params![scope.repository_id,scope.worktree_id],|r|Ok((r.get(0)?,r.get(1)?))).map_err(|e|e.to_string())?
            } else {
                db.query_row(
                    "SELECT count(*),coalesce(sum(length(CAST(value AS BLOB))),0) FROM records",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .map_err(|e| e.to_string())?
            };
            let transactions: i64 = db
                .query_row(
                    "SELECT value FROM metadata WHERE key='transactions'",
                    [],
                    |r| r.get(0),
                )
                .map_err(|e| e.to_string())?;
            let writes: i64 = db
                .query_row("SELECT value FROM metadata WHERE key='writes'", [], |r| {
                    r.get(0)
                })
                .map_err(|e| e.to_string())?;
            Ok(
                json!({"backend":"rust-sqlite","records":records,"bytes":bytes,"transactions":transactions,"writes":writes}),
            )
        }
        "close" => Ok(Value::Null),
        _ => Err("Unknown repository service method".into()),
    }
}
fn serve_connection<R: BufRead, W: Write>(reader: &mut R, writer: &mut W, db: &Mutex<Connection>) {
    loop {
        let mut line = Vec::new();
        let read = (&mut *reader)
            .take((MAX_MESSAGE + 1) as u64)
            .read_until(b'\n', &mut line);
        if read.is_err()
            || line.is_empty()
            || line.len() > MAX_MESSAGE
            || line.last() != Some(&b'\n')
        {
            break;
        }
        let request = match serde_json::from_slice::<Request>(&line) {
            Ok(r) => r,
            Err(_) => break,
        };
        if request.id.is_empty() || request.id.len() > 128 {
            break;
        }
        let result = if request.protocol_version != VERSION {
            Err("Repository protocol version mismatch".into())
        } else {
            db.lock()
                .map_err(|_| "Repository writer unavailable".to_string())
                .and_then(|mut db| dispatch(&mut db, &request.method, request.params))
        };
        let response = match result {
            Ok(value) => json!({"id":request.id,"ok":true,"result":value}),
            Err(message) => json!({"id":request.id,"ok":false,"error":{"message":message}}),
        };
        let bytes = response.to_string();
        if bytes.len() > MAX_MESSAGE
            || writeln!(writer, "{}", bytes).is_err()
            || writer.flush().is_err()
        {
            break;
        }
        if request.method == "close" {
            break;
        }
    }
}

#[cfg(unix)]
fn daemon(directory: PathBuf) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    use std::os::unix::net::{UnixListener, UnixStream};
    let db = Arc::new(Mutex::new(open(&directory)?));
    let socket = directory.join("service.sock");
    let lock_path = directory.join("service.lock");
    if let Ok(meta) = std::fs::symlink_metadata(&lock_path) {
        if !meta.is_file() || meta.file_type().is_symlink() {
            return Err("Unsafe service lock".into());
        }
    }
    let lock = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(lock_path)
        .map_err(|e| e.to_string())?;
    std::fs::set_permissions(
        directory.join("service.lock"),
        std::fs::Permissions::from_mode(0o600),
    )
    .map_err(|e| e.to_string())?;
    if lock.try_lock().is_err() {
        return Ok(());
    }
    if let Ok(meta) = std::fs::symlink_metadata(&socket) {
        use std::os::unix::fs::FileTypeExt;
        if !meta.file_type().is_socket() {
            return Err("Unsafe service socket".into());
        }
    }
    if socket.exists() {
        if UnixStream::connect(&socket).is_ok() {
            return Ok(());
        }
        std::fs::remove_file(&socket).map_err(|e| e.to_string())?;
    }
    let listener = match UnixListener::bind(&socket) {
        Ok(l) => l,
        Err(e) => {
            if UnixStream::connect(&socket).is_ok() {
                return Ok(());
            }
            return Err(e.to_string());
        }
    };
    std::fs::set_permissions(&socket, std::fs::Permissions::from_mode(0o600))
        .map_err(|e| e.to_string())?;
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let active = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let last = Arc::new(Mutex::new(Instant::now()));
    loop {
        match listener.accept() {
            Ok((mut stream, _)) => {
                if active.load(std::sync::atomic::Ordering::SeqCst) >= 32 {
                    continue;
                }
                active.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                let db = db.clone();
                let active = active.clone();
                let last = last.clone();
                std::thread::spawn(move || {
                    let _ = stream.set_read_timeout(Some(Duration::from_secs(60)));
                    let _ = stream.set_write_timeout(Some(Duration::from_secs(60)));
                    if let Ok(copy) = stream.try_clone() {
                        serve_connection(&mut BufReader::new(copy), &mut stream, &db);
                    }
                    active.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
                    if let Ok(mut time) = last.lock() {
                        *time = Instant::now();
                    }
                });
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                if active.load(std::sync::atomic::Ordering::SeqCst) == 0
                    && last.lock().map_err(|e| e.to_string())?.elapsed() > Duration::from_secs(900)
                {
                    break;
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            Err(e) => return Err(e.to_string()),
        }
    }
    std::fs::remove_file(socket).map_err(|e| e.to_string())?;
    Ok(())
}
fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args == ["--version"] {
        println!("openbuff-intelligence 0.1.0 protocol=1");
        return;
    }
    if args.len() != 2 || !["--serve", "--stdio"].contains(&args[0].as_str()) {
        eprintln!("Usage: openbuff-intelligence --serve|--stdio <private-directory>");
        std::process::exit(2);
    }
    let directory = PathBuf::from(&args[1]);
    if !directory.is_absolute() {
        eprintln!("Directory must be absolute");
        std::process::exit(2);
    }
    let result = if args[0] == "--stdio" {
        open(&directory).map(|db| {
            serve_connection(
                &mut BufReader::new(std::io::stdin()),
                &mut std::io::stdout(),
                &Mutex::new(db),
            )
        })
    } else {
        #[cfg(unix)]
        {
            daemon(directory)
        }
        #[cfg(not(unix))]
        {
            Err("Unix service unavailable; use embedded storage".into())
        }
    };
    if let Err(message) = result {
        eprintln!("{}", message);
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn database() -> Connection {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE records(repository TEXT,worktree TEXT,kind TEXT,key TEXT,version TEXT,value TEXT,PRIMARY KEY(repository,worktree,kind,key)); CREATE TABLE metadata(key TEXT PRIMARY KEY,value INTEGER); INSERT INTO metadata VALUES('sequence',0),('transactions',0),('writes',0);").unwrap();
        db
    }
    fn put(key: &str, value: Value) -> Value {
        json!({"scope":{"repositoryId":"r","worktreeId":"w"},"table":"files","key":key,"value":value})
    }
    #[test]
    fn fractional_source_metadata_keeps_exact_numeric_identity() {
        let values = [
            1700000000000.0103_f64,
            0.10000000000000003,
            1.234567890123456e-100,
        ];
        let mut db = database();
        for (index, original) in values.iter().enumerate() {
            let wire = serde_json::to_string(&put(&index.to_string(), json!(original))).unwrap();
            let input: Value = serde_json::from_str(&wire).unwrap();
            dispatch(&mut db, "batch", json!({"puts": [input]})).unwrap();
            let answer = dispatch(&mut db, "get", json!({"scope":{"repositoryId":"r","worktreeId":"w"},"table":"files","key":index.to_string()})).unwrap();
            assert_eq!(
                answer["value"].as_f64().unwrap().to_bits(),
                original.to_bits()
            );
        }
    }
    #[test]
    fn protocol_versions_fail_without_writes() {
        let db = Mutex::new(database());
        let mut bytes = Vec::new();
        serve_connection(
            &mut std::io::Cursor::new(
                b"{\"id\":\"a\",\"protocolVersion\":2,\"method\":\"batch\",\"params\":{}}\n",
            ),
            &mut bytes,
            &db,
        );
        assert_eq!(
            serde_json::from_slice::<Value>(&bytes).unwrap()["ok"],
            false
        );
        assert_eq!(
            dispatch(&mut db.lock().unwrap(), "stats", json!({})).unwrap()["transactions"],
            0
        );
    }
    #[test]
    fn failed_cas_is_transactional_across_scopes() {
        let mut db = database();
        dispatch(&mut db, "batch", json!({"puts":[put("a",json!(1))]})).unwrap();
        let answer=dispatch(&mut db,"batch",json!({"checks":[{"scope":{"repositoryId":"r","worktreeId":"w"},"table":"files","key":"a","expectedVersion":"wrong"}],"puts":[put("b",json!(2))]})).unwrap();
        assert_eq!(answer["committed"], false);
        assert_eq!(dispatch(&mut db, "stats", json!({})).unwrap()["records"], 1);
    }
    #[test]
    fn explicit_missing_keys_do_not_truncate_pages() {
        let mut db = database();
        dispatch(
            &mut db,
            "batch",
            json!({"puts":[put("a",json!(1)),put("b",json!(2)),put("c",json!(3))]}),
        )
        .unwrap();
        let answer=dispatch(&mut db,"query",json!({"scope":{"repositoryId":"r","worktreeId":"w"},"table":"files","keys":["0-missing","a","b","c"],"limit":2})).unwrap();
        assert_eq!(answer["records"].as_array().unwrap().len(), 2);
        assert_eq!(answer["cursor"], "b");
    }
}
