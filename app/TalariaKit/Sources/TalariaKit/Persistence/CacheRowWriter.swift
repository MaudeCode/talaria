import Foundation

/// Change-checked writes to a cached SwiftData row. Assigning an equal value still marks a row
/// dirty, so each field is written only when it differs and unchanged rows stay out of the save.
struct CacheRowWriter<Row: AnyObject> {
    let row: Row
    var encoder = JSONEncoder()
    private(set) var changed = false

    mutating func set<Value: Equatable>(_ field: ReferenceWritableKeyPath<Row, Value>, _ value: Value) {
        guard row[keyPath: field] != value else { return }
        row[keyPath: field] = value
        changed = true
    }

    /// Stores `value` as JSON, skipping the encode when the stored JSON already decodes to it.
    mutating func setJSON<Value: Codable & Equatable>(_ field: ReferenceWritableKeyPath<Row, Data?>, _ value: Value?) {
        guard let value else { return set(field, nil) }
        if let data = row[keyPath: field], (try? JSONDecoder().decode(Value.self, from: data)) == value { return }
        set(field, try? encoder.encode(value))
    }

    /// Renews the row's TTL when it changed or less than half of the TTL remains, rather than on
    /// every write, so repeated saves of unchanged rows stay clean and a cached row never expires while in use.
    mutating func renew(cachedAt: ReferenceWritableKeyPath<Row, Date>, expiresAt: ReferenceWritableKeyPath<Row, Date>, at now: Date) {
        guard renewalDue(row[keyPath: expiresAt], at: now) else { return }
        set(cachedAt, now)
        set(expiresAt, now.addingTimeInterval(CachePolicy.ttl))
    }

    mutating func renew(_ expiresAt: ReferenceWritableKeyPath<Row, Date?>, at now: Date) {
        guard renewalDue(row[keyPath: expiresAt], at: now) else { return }
        set(expiresAt, now.addingTimeInterval(CachePolicy.ttl))
    }

    private func renewalDue(_ expiresAt: Date?, at now: Date) -> Bool {
        changed || (expiresAt ?? .distantPast).timeIntervalSince(now) <= CachePolicy.ttl / 2
    }
}
