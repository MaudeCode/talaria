/** Last 1024 automatic attempts on this origin, shared by every document. No reply text is stored. */
const DATABASE = 'talaria-auto-read'
const LIMIT = 1024

/** A read/write transaction serializes admission across tabs; only a committed claim may start speech. */
export function claimAutoRead(identity: string): Promise<boolean> {
  return new Promise((resolve) => {
    let finished = false
    const finish = (owned: boolean) => { finished = true; resolve(owned) }
    try {
      const request = indexedDB.open(DATABASE, 1)
      request.onerror = () => finish(false)
      request.onblocked = () => finish(false)
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore('claims', { autoIncrement: true })
        store.createIndex('identity', 'identity', { unique: true })
      }
      request.onsuccess = () => {
        const db = request.result
        if (finished) { db.close(); return }
        db.onversionchange = () => db.close()
        try {
          const tx = db.transaction('claims', 'readwrite', { durability: 'strict' })
          let owned = false
          tx.oncomplete = () => { db.close(); finish(owned) }
          tx.onabort = () => { db.close(); finish(false) }
          const store = tx.objectStore('claims')
          const existing = store.index('identity').getKey(identity)
          existing.onsuccess = () => {
            if (existing.result !== undefined) return
            store.add({ identity })
            owned = true
            const count = store.count()
            count.onsuccess = () => {
              let excess = count.result - LIMIT
              if (excess <= 0) return
              const oldest = store.openCursor()
              oldest.onsuccess = () => {
                const cursor = oldest.result
                if (!cursor || excess-- <= 0) return
                cursor.delete()
                cursor.continue()
              }
            }
          }
        } catch { db.close(); finish(false) }
      }
    } catch { finish(false) }
  })
}
