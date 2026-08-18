import Testing
@testable import ReplayCaptureMac

@Test func captureReadinessAcceptsAFrameThatArrivesBeforeTheWaiter() async {
    let readiness = CaptureStartReadiness()
    readiness.frameAppended()

    let outcome = await readiness.wait(timeoutNanoseconds: 50_000_000)

    #expect(outcome == .frameAppended)
}

@Test func captureReadinessReportsAStreamFailurePromptly() async {
    let readiness = CaptureStartReadiness()
    let waiting = Task {
        await readiness.wait(timeoutNanoseconds: 1_000_000_000)
    }

    readiness.fail()

    #expect(await waiting.value == .captureFailed)
}

@Test func captureReadinessTimesOutWhenNoFrameArrives() async {
    let readiness = CaptureStartReadiness()

    let outcome = await readiness.wait(timeoutNanoseconds: 5_000_000)

    #expect(outcome == .timedOut)
}

@Test func captureReadinessKeepsTheFirstTerminalOutcome() async {
    let readiness = CaptureStartReadiness()
    readiness.frameAppended()
    readiness.fail()

    let outcome = await readiness.wait(timeoutNanoseconds: 50_000_000)

    #expect(outcome == .frameAppended)
}
