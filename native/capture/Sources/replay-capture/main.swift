import Darwin
import Foundation
import ReplayCaptureCore
import ReplayCaptureMac

@main
struct ReplayCaptureMain {
    static func main() async {
        // Screen, audio, and screenshot artifacts are private even during the
        // short interval before adapters apply explicit file attributes.
        _ = Darwin.umask(0o077)
        let output = JSONLineOutput()
        let safetyInterlock = SafetyInterlock()
        let service = SidecarService(
            recorder: MacScreenRecorder(),
            inputMonitor: MacInputMonitor(),
            permissions: MacPermissionProvider(),
            actions: MacActionPerformer(safetyInterlock: safetyInterlock),
            safetyMonitor: MacSafetyMonitor(safetyInterlock: safetyInterlock),
            safetyInterlock: safetyInterlock,
            safetyEventSink: { event in
                await output.write(event)
            }
        )

        installTerminationHandlers(for: service)

        while let line = readLine(strippingNewline: true) {
            guard !line.isEmpty else { continue }
            let response: SidecarResponse
            do {
                let command = try JSONDecoder.replay.decode(
                    SidecarCommandEnvelope.self,
                    from: Data(line.utf8)
                )
                response = await service.handle(command)
            } catch {
                response = .failure(
                    requestId: requestId(from: line) ?? "unknown",
                    code: .invalidCommand,
                    message: "The command was not valid protocol JSON."
                )
            }
            await output.write(response)
        }

        await service.shutdown()
    }

    private static func requestId(from line: String) -> String? {
        guard let object = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any] else {
            return nil
        }
        return object["requestId"] as? String
    }

    private static func installTerminationHandlers(for service: SidecarService) {
        signal(SIGINT, SIG_IGN)
        signal(SIGTERM, SIG_IGN)
        for signalNumber in [SIGINT, SIGTERM] {
            let source = DispatchSource.makeSignalSource(
                signal: signalNumber,
                queue: .global(qos: .userInitiated)
            )
            source.setEventHandler {
                Task {
                    await service.shutdown()
                    Darwin.exit(0)
                }
            }
            source.resume()
            SignalSources.shared.retain(source)
        }
    }
}

private actor JSONLineOutput {
    func write<Value: Encodable & Sendable>(_ value: Value) {
        guard var data = try? JSONEncoder.replay.encode(value) else { return }
        data.append(0x0A)
        try? FileHandle.standardOutput.write(contentsOf: data)
    }
}

private final class SignalSources: @unchecked Sendable {
    static let shared = SignalSources()
    private var sources: [DispatchSourceSignal] = []
    private let lock = NSLock()

    func retain(_ source: DispatchSourceSignal) {
        lock.lock()
        sources.append(source)
        lock.unlock()
    }
}
