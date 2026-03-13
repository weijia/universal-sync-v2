/**
 * Lightweight in-memory PouchDB-like adapter for testing / in-memory usage.
 * Implements the minimal API used by SyncEngine: `info`, `get`, `bulkDocs`, `allDocs`.
 */
export default class MemoryPouchDB {
  private name: string;
  private docs: Map<string, any> = new Map();
  private seq = 0;

  constructor(name = 'memory') {
    this.name = name;
  }

  private nextSeq() {
    this.seq += 1;
    return this.seq;
  }

  async info() {
    return {
      db_name: this.name,
      doc_count: this.docs.size,
      update_seq: this.seq,
    };
  }

  async get(id: string) {
    if (!this.docs.has(id)) {
      const err: any = new Error('missing');
      err.status = 404;
      throw err;
    }
    // return a shallow clone to mimic Pouch behaviour
    const d = this.docs.get(id);
    return { ...d };
  }

  /**
   * Accepts an array of docs. For each doc we assign/advance a _rev and update internal seq.
   */
  async bulkDocs(docs: any[]) {
    if (!Array.isArray(docs)) docs = [docs];
    const results: any[] = [];

    for (const doc of docs) {
      const id = doc._id || (doc.id || `doc_${Date.now()}_${Math.random().toString(36).slice(2,8)}`);
      const seq = this.nextSeq();
      const rev = `${seq}-local`;

      const stored = { ...doc, _id: id, _rev: rev };
      this.docs.set(id, stored);

      results.push({ id, ok: true, rev });
    }

    return { results };
  }

  /**
   * Returns allDocs with optional include_docs flag.
   */
  async allDocs(opts: { include_docs?: boolean } = {}) {
    const rows: any[] = [];
    for (const [id, doc] of this.docs.entries()) {
      if (opts.include_docs) rows.push({ id, doc: { ...doc } });
      else rows.push({ id });
    }
    return { total_rows: rows.length, offset: 0, rows };
  }
}
