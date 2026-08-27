import Foundation
import Combine

@MainActor
final class PlantReportService: ObservableObject {
    @Published private(set) var report:  PlantReport?
    @Published private(set) var error:   String?
    @Published private(set) var loading: Bool = false
    @Published private(set) var lastLoaded: Date?
    /// True when the signed-in user has no sensors configured yet.
    @Published private(set) var needsOnboarding = false
    /// Per-account dashboard title (e.g. "Nober's PlantWatch"), nil until loaded.
    @Published private(set) var gardenName: String?

    private var refreshTask: Task<Void, Never>?

    func load(silent: Bool = false, retried: Bool = false) async {
        if !silent { loading = true }
        defer { loading = false }
        do {
            // Don't sign out if we can't get a token — a transient blip shouldn't
            // kick the user to the login screen. Keep the session and retry later.
            guard let token = await Auth.shared.accessToken() else { return }
            await loadGardenName()
            var req = URLRequest(url: Config.endpoint)
            req.cachePolicy = .reloadIgnoringLocalCacheData
            req.setValue(Config.supabaseAnonKey, forHTTPHeaderField: "apikey")
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            let (data, resp) = try await URLSession.shared.data(for: req)
            let status = (resp as? HTTPURLResponse)?.statusCode ?? 500
            if status == 401 {
                // Force one refresh + retry. refresh() only signs out if the
                // refresh token is genuinely dead, so a blip won't log them out.
                if !retried, await Auth.shared.refresh() { await load(silent: silent, retried: true) }
                return
            }
            guard status == 200 else { throw URLError(.badServerResponse) }

            // New user with no plants yet.
            if let probe = try? JSONDecoder().decode(OnboardProbe.self, from: data), probe.needs_onboarding == true {
                self.needsOnboarding = true; self.error = nil; return
            }
            let decoder = JSONDecoder()
            decoder.dateDecodingStrategy = .iso8601
            let parsed = try decoder.decode(PlantReport.self, from: data)
            self.report = parsed
            self.error = nil
            self.lastLoaded = Date()
            self.needsOnboarding = false
            Preferences.shared.notifyIfChanged(parsed.applying(Preferences.shared).readings)
        } catch {
            self.error = humanize(error)
            if self.report == nil { /* preserve previous data on transient failures */ }
        }
    }

    private struct OnboardProbe: Decodable { let needs_onboarding: Bool? }

    /// Fetch the account's dashboard title once (cached for the session).
    private func loadGardenName() async {
        guard gardenName == nil else { return }
        guard let d = try? await Auth.shared.authed("rest/v1/profiles?select=garden_name") else { return }
        if let rows = try? JSONSerialization.jsonObject(with: d) as? [[String: Any]],
           let gn = rows.first?["garden_name"] as? String, !gn.isEmpty {
            gardenName = gn
        }
    }

    func startAutoRefresh() {
        refreshTask?.cancel()
        refreshTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: UInt64(Config.autoRefreshInterval * 1_000_000_000))
                await self?.load(silent: true)
            }
        }
    }

    func stopAutoRefresh() { refreshTask?.cancel() }

    private func humanize(_ error: Error) -> String {
        if let e = error as? URLError {
            switch e.code {
            case .notConnectedToInternet: return "No internet connection."
            case .timedOut:               return "Connection timed out — try again."
            case .badServerResponse:      return "Backend isn't responding correctly."
            default:                      return e.localizedDescription
            }
        }
        return error.localizedDescription
    }
}
