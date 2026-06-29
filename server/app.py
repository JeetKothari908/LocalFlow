import json
import os
import sqlite3
import threading
import time
import uuid
from contextlib import closing
from typing import Any

from fastapi import FastAPI, Header, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel


DB_PATH = os.getenv("LOCALFLOW_DB", "localflow.sqlite3")
AUTH_TOKEN = os.getenv("LOCALFLOW_TOKEN", "")
HISTORY_LIMIT = max(0, int(os.getenv("LOCALFLOW_HISTORY_LIMIT", "500")))

app = FastAPI(title="LocalFlow Sync API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
    allow_headers=["authorization", "content-type"],
)

_schema_lock = threading.Lock()


def _ensure_column(
    conn: sqlite3.Connection,
    table: str,
    column: str,
    definition: str,
) -> None:
    columns = {row[1] for row in conn.execute(f"pragma table_info({table})")}
    if column not in columns:
        conn.execute(f"alter table {table} add column {column} {definition}")


def _initialize_schema(conn: sqlite3.Connection) -> None:
    with _schema_lock:
        conn.execute(
            """
            create table if not exists kv (
              store text not null,
              key text not null,
              value text,
              deleted integer not null default 0,
              updated_at integer not null,
              version integer not null default 1,
              primary key (store, key)
            )
            """
        )
        _ensure_column(conn, "kv", "version", "integer not null default 1")

        conn.execute(
            """
            create table if not exists kv_revisions (
              id integer primary key autoincrement,
              store text not null,
              key text not null,
              version integer not null,
              value text,
              deleted integer not null default 0,
              changed_at integer not null,
              client_id text,
              request_id text,
              operation text not null default 'write',
              restored_from integer,
              unique (store, key, version)
            )
            """
        )
        _ensure_column(
            conn,
            "kv_revisions",
            "operation",
            "text not null default 'write'",
        )
        _ensure_column(conn, "kv_revisions", "restored_from", "integer")
        conn.execute(
            """
            create index if not exists revisions_lookup
            on kv_revisions (store, key, version desc)
            """
        )

        # Existing values become version 1, giving every key a recoverable baseline.
        conn.execute(
            """
            insert or ignore into kv_revisions (
              store, key, version, value, deleted, changed_at,
              client_id, request_id, operation, restored_from
            )
            select
              store, key, version, value, deleted, updated_at,
              null, null, 'baseline', null
            from kv
            """
        )
        conn.commit()


def connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, timeout=5)
    conn.row_factory = sqlite3.Row
    conn.execute("pragma busy_timeout = 5000")
    _initialize_schema(conn)
    return conn


def check_auth(authorization: str | None) -> None:
    if AUTH_TOKEN and authorization != f"Bearer {AUTH_TOKEN}":
        raise HTTPException(status_code=401, detail="Unauthorized")


class Change(BaseModel):
    key: str
    value: Any | None = None
    deleted: bool = False
    baseVersion: int | None = None


class Changes(BaseModel):
    changes: list[Change]
    clientId: str | None = None
    requestId: str | None = None


class RestoreRevision(BaseModel):
    store: str
    key: str
    version: int
    baseVersion: int | None = None
    clientId: str | None = None


def _serialized_value(change: Change) -> str | None:
    if change.deleted:
        return None
    return json.dumps(
        change.value,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    )


def _same_value(
    current: sqlite3.Row | None,
    value: str | None,
    deleted: bool,
) -> bool:
    if current is None or bool(current["deleted"]) != deleted:
        return False
    if deleted:
        return True
    try:
        return json.loads(current["value"]) == json.loads(value or "null")
    except (TypeError, json.JSONDecodeError):
        return current["value"] == value


def _prune_history(conn: sqlite3.Connection, store: str, key: str) -> None:
    if HISTORY_LIMIT <= 0:
        return
    conn.execute(
        """
        delete from kv_revisions
        where id in (
          select id from kv_revisions
          where store = ? and key = ?
          order by version desc
          limit -1 offset ?
        )
        """,
        (store, key, HISTORY_LIMIT),
    )


def _write_changes(
    conn: sqlite3.Connection,
    store: str,
    changes: list[Change],
    *,
    client_id: str | None,
    request_id: str,
    operation: str = "write",
    restored_from: dict[str, int] | None = None,
) -> dict[str, int]:
    if len({change.key for change in changes}) != len(changes):
        raise HTTPException(status_code=400, detail="Duplicate keys in change batch")

    now = int(time.time())
    versions: dict[str, int] = {}
    restored_from = restored_from or {}

    for change in changes:
        current = conn.execute(
            """
            select value, deleted, version
            from kv where store = ? and key = ?
            """,
            (store, change.key),
        ).fetchone()
        current_version = int(current["version"]) if current else 0
        value = _serialized_value(change)

        # A stale client that is already asking for the current value is safe.
        if _same_value(current, value, change.deleted):
            versions[change.key] = current_version
            continue

        if (
            change.baseVersion is not None
            and change.baseVersion != current_version
        ):
            raise HTTPException(
                status_code=409,
                detail={
                    "message": "The record changed on another device.",
                    "key": change.key,
                    "baseVersion": change.baseVersion,
                    "currentVersion": current_version,
                },
            )

        next_version = current_version + 1
        deleted = int(change.deleted)
        conn.execute(
            """
            insert into kv_revisions (
              store, key, version, value, deleted, changed_at,
              client_id, request_id, operation, restored_from
            ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                store,
                change.key,
                next_version,
                value,
                deleted,
                now,
                client_id,
                request_id,
                operation,
                restored_from.get(change.key),
            ),
        )
        conn.execute(
            """
            insert into kv (store, key, value, deleted, updated_at, version)
            values (?, ?, ?, ?, ?, ?)
            on conflict(store, key) do update set
              value = excluded.value,
              deleted = excluded.deleted,
              updated_at = excluded.updated_at,
              version = excluded.version
            """,
            (store, change.key, value, deleted, now, next_version),
        )
        _prune_history(conn, store, change.key)
        versions[change.key] = next_version

    return versions


@app.get("/health")
def health() -> dict[str, bool]:
    return {"ok": True}


@app.get("/v1/history")
def get_history(
    store: str,
    key: str,
    limit: int = Query(default=50, ge=1, le=200),
    authorization: str | None = Header(default=None),
) -> dict[str, Any]:
    check_auth(authorization)
    with closing(connect()) as conn:
        rows = conn.execute(
            """
            select
              id, store, key, version, value, deleted, changed_at,
              client_id, request_id, operation, restored_from
            from kv_revisions
            where store = ? and key = ?
            order by version desc
            limit ?
            """,
            (store, key, limit),
        ).fetchall()

    revisions = []
    for row in rows:
        revision: dict[str, Any] = {
            "id": row["id"],
            "store": row["store"],
            "key": row["key"],
            "version": row["version"],
            "deleted": bool(row["deleted"]),
            "changedAt": row["changed_at"],
            "clientId": row["client_id"],
            "requestId": row["request_id"],
            "operation": row["operation"],
            "restoredFrom": row["restored_from"],
        }
        if not row["deleted"]:
            revision["value"] = json.loads(row["value"])
        revisions.append(revision)
    return {"revisions": revisions}


@app.post("/v1/history/restore")
def restore_revision(
    body: RestoreRevision,
    authorization: str | None = Header(default=None),
) -> dict[str, Any]:
    check_auth(authorization)
    with closing(connect()) as conn:
        revision = conn.execute(
            """
            select value, deleted from kv_revisions
            where store = ? and key = ? and version = ?
            """,
            (body.store, body.key, body.version),
        ).fetchone()
        if revision is None:
            raise HTTPException(status_code=404, detail="Revision not found")

        value = None
        if not revision["deleted"]:
            value = json.loads(revision["value"])
        change = Change(
            key=body.key,
            value=value,
            deleted=bool(revision["deleted"]),
            baseVersion=body.baseVersion,
        )

        try:
            conn.execute("begin immediate")
            versions = _write_changes(
                conn,
                body.store,
                [change],
                client_id=body.clientId,
                request_id=uuid.uuid4().hex,
                operation="restore",
                restored_from={body.key: body.version},
            )
            conn.commit()
        except Exception:
            conn.rollback()
            raise

    return {"ok": True, "versions": versions}


@app.delete("/v1/history")
def purge_history(
    store: str,
    key: str | None = None,
    authorization: str | None = Header(default=None),
) -> dict[str, int | bool]:
    check_auth(authorization)
    with closing(connect()) as conn:
        try:
            conn.execute("begin immediate")
            if key is None:
                current_rows = conn.execute(
                    "select * from kv where store = ?",
                    (store,),
                ).fetchall()
                deleted_count = conn.execute(
                    "delete from kv_revisions where store = ?",
                    (store,),
                ).rowcount
            else:
                current_rows = conn.execute(
                    "select * from kv where store = ? and key = ?",
                    (store, key),
                ).fetchall()
                deleted_count = conn.execute(
                    "delete from kv_revisions where store = ? and key = ?",
                    (store, key),
                ).rowcount

            # Keep one non-sensitive baseline for the current state. Deleted
            # records retain only a NULL tombstone after purging.
            for row in current_rows:
                conn.execute(
                    """
                    insert into kv_revisions (
                      store, key, version, value, deleted, changed_at,
                      client_id, request_id, operation, restored_from
                    ) values (?, ?, ?, ?, ?, ?, null, null, 'baseline', null)
                    """,
                    (
                        row["store"],
                        row["key"],
                        row["version"],
                        row["value"],
                        row["deleted"],
                        row["updated_at"],
                    ),
                )
            conn.commit()
        except Exception:
            conn.rollback()
            raise

    retained_count = len(current_rows)
    return {
        "ok": True,
        "deleted": max(0, deleted_count - retained_count),
        "retained": retained_count,
    }


@app.get("/v1/stores/{store:path}")
def get_store(
    store: str,
    authorization: str | None = Header(default=None),
) -> dict[str, list[dict[str, Any]]]:
    check_auth(authorization)

    with closing(connect()) as conn:
        rows = conn.execute(
            """
            select key, value, deleted, version, updated_at
            from kv where store = ? order by key
            """,
            (store,),
        ).fetchall()

    changes = []
    for row in rows:
        change: dict[str, Any] = {
            "key": row["key"],
            "version": row["version"],
            "updatedAt": row["updated_at"],
        }
        if row["deleted"]:
            change["deleted"] = True
        else:
            change["value"] = json.loads(row["value"])
        changes.append(change)

    return {"changes": changes}


@app.post("/v1/stores/{store:path}/changes")
def apply_changes(
    store: str,
    body: Changes,
    authorization: str | None = Header(default=None),
) -> dict[str, Any]:
    check_auth(authorization)
    request_id = body.requestId or uuid.uuid4().hex

    with closing(connect()) as conn:
        try:
            conn.execute("begin immediate")
            versions = _write_changes(
                conn,
                store,
                body.changes,
                client_id=body.clientId,
                request_id=request_id,
            )
            conn.commit()
        except Exception:
            conn.rollback()
            raise

    return {"ok": True, "versions": versions, "requestId": request_id}
