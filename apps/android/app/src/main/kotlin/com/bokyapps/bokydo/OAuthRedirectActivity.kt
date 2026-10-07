package com.bokyapps.bokydo

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import kotlinx.coroutines.launch

/**
 * Receives `com.bokyapps.bokydo:/oauth2redirect?...` from the browser, hands it to the app (which
 * checks it against the sign-in in progress) and returns to the main screen. It has no UI and
 * trusts nothing in the intent: the checks live in [com.bokyapps.bokydo.core.PendingAuth.accept].
 */
class OAuthRedirectActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val redirect = intent?.dataString
        val app = app
        if (redirect != null && intent?.action == Intent.ACTION_VIEW) {
            app.scope.launch { app.finishSignIn(redirect) }
        }
        startActivity(
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP),
        )
        finish()
    }
}
