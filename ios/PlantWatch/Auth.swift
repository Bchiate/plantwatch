import Foundation
import SwiftUI

/// Manages the Supabase auth session: sign-in / sign-up, token refresh, and a
/// persisted session so the user stays logged in until they sign out.
@MainActor
final class Auth: ObservableObject {
    static let shared = Auth()

    @Published private(set) var session: Session?
    /// True when the signed-in account is an admin (routes to the admin dashboard).
    @Published private(set) var isAdmin = false
    var isAuthed: Bool { session != nil }
    var email: String? { session?.user.email }

    /// Fetch the admin flag for the current user from their profile.
    func loadAdminFlag() async {
        guard isAuthed else { isAdmin = false; return }
        guard let d = try? await authed("rest/v1/profiles?select=is_admin"),
              let rows = try? JSONSerialization.jsonObject(with: d) as? [[String: Any]] else { return }
        isAdmin = (rows.first?["is_admin"] as? Bool) ?? false
    }

    struct User: Codable { let id: String; let email: String? }
    struct Session: Codable {
        var access_token: String
        var refresh_token: String
        var expires_at: Double?
        var user: User
    }

    private let key = "pw-session"

    private init() {
        if let data = UserDefaults.standard.data(forKey: key),
           let s = try? JSONDecoder().decode(Session.self, from: data) {
            session = s
        }
    }

    private func save(_ s: Session) {
        session = s
        if let d = try? JSONEncoder().encode(s) { UserDefaults.standard.set(d, forKey: key) }
    }
    func signOut() {
        session = nil
        isAdmin = false
        UserDefaults.standard.removeObject(forKey: key)
    }

    enum AuthError: LocalizedError {
        case message(String)
        var errorDescription: String? { if case let .message(m) = self { return m }; return nil }
    }

    private func gotrue(_ path: String, body: [String: String]) async throws -> Session {
        var req = URLRequest(url: URL(string: "\(Config.supabaseUrl)/auth/v1/\(path)")!)
        req.httpMethod = "POST"
        req.setValue(Config.supabaseAnonKey, forHTTPHeaderField: "apikey")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, resp) = try await URLSession.shared.data(for: req)
        let http = resp as? HTTPURLResponse
        if (http?.statusCode ?? 500) >= 400 {
            let msg = (try? JSONDecoder().decode(GoTrueError.self, from: data))?.message ?? "Authentication failed"
            throw AuthError.message(msg)
        }
        return try JSONDecoder().decode(Session.self, from: data)
    }
    struct GoTrueError: Codable {
        let message: String?
        let error_description: String?
        let msg: String?
        var display: String { error_description ?? msg ?? message ?? "Error" }
        enum CodingKeys: String, CodingKey { case message, error_description, msg }
    }

    func signIn(email: String, password: String) async throws {
        let s = try await gotrue("token?grant_type=password", body: ["email": email, "password": password])
        save(s)
    }
    /// Returns true if a session was created, false if email confirmation is required.
    func signUp(email: String, password: String) async throws -> Bool {
        var req = URLRequest(url: URL(string: "\(Config.supabaseUrl)/auth/v1/signup")!)
        req.httpMethod = "POST"
        req.setValue(Config.supabaseAnonKey, forHTTPHeaderField: "apikey")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject: ["email": email, "password": password])
        let (data, resp) = try await URLSession.shared.data(for: req)
        if (resp as? HTTPURLResponse)?.statusCode ?? 500 >= 400 {
            let e = try? JSONDecoder().decode(GoTrueError.self, from: data)
            throw AuthError.message(e?.display ?? "Sign-up failed")
        }
        if let s = try? JSONDecoder().decode(Session.self, from: data), !s.access_token.isEmpty {
            save(s); return true
        }
        return false  // confirmation email sent
    }

    /// Refresh the session. Signs out ONLY when the server explicitly rejects
    /// the refresh token (400/401) — i.e. the session is genuinely dead. Network
    /// errors / 5xx keep the session so a brief outage never logs the user out.
    @discardableResult
    func refresh() async -> Bool {
        guard let rt = session?.refresh_token else { return false }
        do {
            var req = URLRequest(url: URL(string: "\(Config.supabaseUrl)/auth/v1/token?grant_type=refresh_token")!)
            req.httpMethod = "POST"
            req.setValue(Config.supabaseAnonKey, forHTTPHeaderField: "apikey")
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try JSONSerialization.data(withJSONObject: ["refresh_token": rt])
            let (data, resp) = try await URLSession.shared.data(for: req)
            let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
            if code == 200, let s = try? JSONDecoder().decode(Session.self, from: data) { save(s); return true }
            if code == 400 || code == 401 { signOut() }   // refresh token is truly invalid
            return false                                  // transient (5xx / network) → keep session
        } catch {
            return false                                  // network error → keep session, retry later
        }
    }

    /// A valid access token, refreshing if it's about to expire. On a transient
    /// refresh failure it returns the current token (if not hard-expired) rather
    /// than nil, so callers don't treat a blip as "signed out".
    func accessToken() async -> String? {
        guard let s = session else { return nil }
        let exp = s.expires_at ?? 0
        let now = Date().timeIntervalSince1970
        if now > exp - 60 {
            if await refresh() { return session?.access_token }
            if now < exp { return session?.access_token }   // still valid → keep using it
            return nil
        }
        return s.access_token
    }

    var userId: String? { session?.user.id }

    /// Authenticated request to a Supabase path (e.g. "rest/v1/plants",
    /// "functions/v1/ecowitt-devices"). RLS scopes DB calls to this user.
    @discardableResult
    func authed(_ path: String, method: String = "GET", json body: Any? = nil, prefer: String? = nil) async throws -> Data {
        guard let token = await accessToken() else { throw AuthError.message("Not signed in") }
        var req = URLRequest(url: URL(string: "\(Config.supabaseUrl)/\(path)")!)
        req.httpMethod = method
        req.setValue(Config.supabaseAnonKey, forHTTPHeaderField: "apikey")
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let prefer { req.setValue(prefer, forHTTPHeaderField: "Prefer") }
        if let body { req.httpBody = try JSONSerialization.data(withJSONObject: body) }
        let (data, resp) = try await URLSession.shared.data(for: req)
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 500
        if code >= 400 {
            let txt = String(data: data, encoding: .utf8) ?? ""
            throw AuthError.message(txt.isEmpty ? "Server error \(code)" : txt)
        }
        return data
    }
}
