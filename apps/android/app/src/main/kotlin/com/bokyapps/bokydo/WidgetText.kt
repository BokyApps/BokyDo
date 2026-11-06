package com.bokyapps.bokydo

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Typeface
import android.text.Layout
import android.text.StaticLayout
import android.text.TextPaint
import android.text.TextUtils
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.unit.dp
import androidx.core.content.res.ResourcesCompat
import androidx.glance.GlanceModifier
import androidx.glance.Image
import androidx.glance.ImageProvider
import androidx.glance.LocalContext
import androidx.glance.LocalSize
import androidx.glance.layout.height
import androidx.glance.layout.width
import androidx.glance.text.FontWeight
import androidx.glance.text.TextStyle
import kotlin.math.ceil

/** RemoteViews cannot load custom typefaces. Render bounded text with the app's bundled face,
 * retaining the full text as its accessibility label. Widget lists are capped to bound bitmap IPC.
 */
@Composable
internal fun WidgetText(text: String, modifier: GlanceModifier = GlanceModifier, style: TextStyle = TextStyle(), maxLines: Int = 1) {
    val context = LocalContext.current
    val metrics = context.resources.displayMetrics
    val font = context.app.lastState.user?.prefs?.appearance?.font ?: "inter"
    val resource = when (font) {
        "ibm-plex-sans" -> R.font.ibm_plex_sans
        "atkinson" -> R.font.atkinson
        "lexend" -> R.font.lexend
        "opendyslexic" -> R.font.opendyslexic
        "jetbrains-mono" -> R.font.jetbrains_mono
        "fira-code" -> R.font.fira_code
        else -> R.font.inter
    }
    val size = (style.fontSize?.value ?: 14f) * metrics.scaledDensity
    val color = style.color.getColor(context).toArgb()
    val available = ((LocalSize.current.width.value - 72).coerceAtLeast(60f) * metrics.density).toInt()
    val bold = style.fontWeight == FontWeight.Bold || style.fontWeight == FontWeight.Medium
    val bitmap = remember(text, resource, size, color, available, bold, maxLines) {
        val paint = TextPaint(Paint.ANTI_ALIAS_FLAG).apply {
            typeface = Typeface.create(requireNotNull(ResourcesCompat.getFont(context, resource)), if (bold) Typeface.BOLD else Typeface.NORMAL)
            textSize = size
            this.color = color
        }
        val width = ceil(paint.measureText(text).toDouble()).toInt().coerceIn(1, available)
        val layout = StaticLayout.Builder.obtain(text, 0, text.length, paint, width)
            .setAlignment(Layout.Alignment.ALIGN_NORMAL).setIncludePad(false)
            .setMaxLines(maxLines.coerceIn(1, 3)).setEllipsize(TextUtils.TruncateAt.END).build()
        Bitmap.createBitmap(width, layout.height.coerceAtLeast(1), Bitmap.Config.ARGB_8888).also { layout.draw(Canvas(it)) }
    }
    Image(ImageProvider(bitmap), contentDescription = text,
        modifier = modifier.width((bitmap.width / metrics.density).dp).height((bitmap.height / metrics.density).dp))
}
