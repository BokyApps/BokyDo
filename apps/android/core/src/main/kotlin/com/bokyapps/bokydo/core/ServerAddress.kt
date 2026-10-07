package com.bokyapps.bokydo.core

import java.net.URI
import java.net.URISyntaxException

/** A BokyDo server the user typed in, reduced to its origin ("https://tasks.example.com"). */
data class ServerAddress(val origin: String, val host: String, val insecure: Boolean) {
    companion object {
        /**
         * Parse what the user typed. https is required, except for addresses that can only be on
         * the user's own network (loopback, private IPv4 ranges, `.local`/`.lan`/`.home.arpa`
         * names), where plain http is allowed with a warning, as the web app allows for LAN
         * installs. Instances are origin-only: paths, credentials, queries and fragments are
         * refused.
         */
        fun parse(input: String): Result {
            val trimmed = input.trim()
            if (trimmed.isEmpty()) return Result.Invalid("Enter your server's address")
            val withScheme = if ("://" in trimmed) trimmed else "https://$trimmed"
            val uri = try {
                URI(withScheme)
            } catch (_: URISyntaxException) {
                return Result.Invalid("That isn't a valid address")
            }
            val scheme = uri.scheme?.lowercase()
            if (scheme != "https" && scheme != "http") return Result.Invalid("Use an https:// address")
            val host = uri.host?.lowercase()?.removeSuffix(".")
            if (host.isNullOrEmpty()) return Result.Invalid("That isn't a valid address")
            if (uri.rawUserInfo != null) return Result.Invalid("Leave out user names and passwords")
            if (uri.rawQuery != null || uri.rawFragment != null || (uri.rawPath ?: "").trimEnd('/').isNotEmpty()) {
                return Result.Invalid("Enter just the server address, without a path")
            }
            val port = uri.port
            if (port == 0 || port > 65535) return Result.Invalid("That isn't a valid port")
            val insecure = scheme == "http"
            if (insecure && !isLocalNetwork(host)) {
                return Result.Invalid("Plain http is only allowed on your own network; use https")
            }
            val defaultPort = if (insecure) 80 else 443
            val origin = buildString {
                append(scheme).append("://").append(if (':' in host && !host.startsWith('[')) "[$host]" else host)
                if (port != -1 && port != defaultPort) append(':').append(port)
            }
            return Result.Ok(ServerAddress(origin, host, insecure))
        }

        /** Hosts that can only be reached on the user's own network. */
        fun isLocalNetwork(host: String): Boolean {
            val h = host.removePrefix("[").removeSuffix("]")
            if (h == "localhost" || h.endsWith(".localhost") || h == "::1") return true
            if (h.endsWith(".local") || h.endsWith(".lan") || h.endsWith(".home.arpa") || h.endsWith(".internal")) {
                return true
            }
            val parts = h.split('.')
            if (parts.size != 4) return false
            val b = parts.map { p -> p.toIntOrNull()?.takeIf { it in 0..255 && p == it.toString() } ?: return false }
            return b[0] == 127 || b[0] == 10 ||
                (b[0] == 172 && b[1] in 16..31) ||
                (b[0] == 192 && b[1] == 168) ||
                (b[0] == 100 && b[1] in 64..127)
        }
    }

    sealed interface Result {
        data class Ok(val address: ServerAddress) : Result
        data class Invalid(val reason: String) : Result
    }
}
