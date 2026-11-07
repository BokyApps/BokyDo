package com.bokyapps.bokydo;

import android.os.Bundle;

/** Runs in the helper package so starting instrumentation cannot force-stop the upgraded
 * widget provider and clear the very RemoteViews whose retention we are verifying. */
public final class WidgetRetentionInstrumentation extends ReleaseMatrixInstrumentation {
    @Override public void onCreate(Bundle arguments) {
        Bundle args = arguments == null ? new Bundle() : new Bundle(arguments);
        args.putString("updatedOnly", "true");
        super.onCreate(args);
    }
}
