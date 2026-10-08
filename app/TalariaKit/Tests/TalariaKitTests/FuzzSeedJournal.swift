import Foundation

/// Names the fuzz property and seed in flight, so an input that traps the test
/// process still leaves its reproducing seed behind (TAL-175). The record is a
/// shared, file-backed memory mapping: the kernel keeps its pages after the
/// process dies, and recording a seed is a few byte stores with no system call.
///
/// Off unless `TALARIA_FUZZ_SEED_JOURNAL_DIR` names a directory. Each test
/// process owns one fixed-size record there, `fuzz-seed-<pid>.txt`, which
/// reads `<test name> seed <seed>` while a property runs and
/// `<test name> completed` once it finishes.
struct FuzzSeedJournal {
    private static let recordSize = 512
    /// `seed ` and the 20 digits of the largest `UInt64`.
    private static let statusWidth = 25

    nonisolated(unsafe) private static let mapping: UnsafeMutableRawBufferPointer? = {
        guard let directory = ProcessInfo.processInfo.environment["TALARIA_FUZZ_SEED_JOURNAL_DIR"],
              !directory.isEmpty
        else { return nil }

        try? FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
        let path = URL(fileURLWithPath: directory).appendingPathComponent("fuzz-seed-\(getpid()).txt").path
        let descriptor = open(path, O_RDWR | O_CREAT | O_TRUNC, 0o644)
        precondition(descriptor >= 0, "Cannot open the fuzz seed journal at \(path).")
        defer { close(descriptor) }
        precondition(ftruncate(descriptor, off_t(recordSize)) == 0, "Cannot size the fuzz seed journal at \(path).")
        let start = mmap(nil, recordSize, PROT_READ | PROT_WRITE, MAP_SHARED, descriptor, 0)
        precondition(start != MAP_FAILED, "Cannot map the fuzz seed journal at \(path).")
        return UnsafeMutableRawBufferPointer(start: start, count: recordSize)
    }()

    private let status: UnsafeMutableRawBufferPointer

    /// Starts a record for `testName`, or returns `nil` when journaling is off.
    static func begin(_ testName: String) -> FuzzSeedJournal? {
        guard let mapping else { return nil }
        let name = testName.utf8.prefix(recordSize - statusWidth - 2)
        mapping.initializeMemory(as: UInt8.self, repeating: UInt8(ascii: " "))
        mapping.copyBytes(from: name)
        mapping[name.count + 1 + statusWidth] = UInt8(ascii: "\n")
        return FuzzSeedJournal(status: UnsafeMutableRawBufferPointer(
            rebasing: mapping[(name.count + 1)..<(name.count + 1 + statusWidth)]
        ))
    }

    /// Names `seed` as the input about to run.
    func record(_ seed: UInt64) {
        write("seed ")
        var digits = 1
        var remaining = seed
        while remaining >= 10 {
            digits += 1
            remaining /= 10
        }
        remaining = seed
        for index in stride(from: 4 + digits, to: 4, by: -1) {
            status[index] = UInt8(ascii: "0") + UInt8(remaining % 10)
            remaining /= 10
        }
    }

    /// Marks the property finished, so a later crash is not blamed on its last seed.
    func finish() {
        write("completed")
    }

    private func write(_ text: StaticString) {
        status.initializeMemory(as: UInt8.self, repeating: UInt8(ascii: " "))
        status.copyBytes(from: UnsafeRawBufferPointer(start: text.utf8Start, count: text.utf8CodeUnitCount))
    }
}
