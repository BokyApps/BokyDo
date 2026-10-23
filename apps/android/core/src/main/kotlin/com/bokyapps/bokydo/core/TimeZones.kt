package com.bokyapps.bokydo.core

import java.text.Normalizer
import java.time.Instant
import java.time.ZoneId
import java.util.Locale
import kotlin.math.abs

/**
 * One zone in the picker: where it is, how far from UTC it is right now and what time it is
 * there. The search matches the web's (PLAN §4b): city, country, alias, abbreviation, UTC
 * offset in any spelling, or the IANA name.
 */
data class ZoneOption(
    val id: String,
    val city: String,
    val country: String,
    val countryCode: String,
    /** Minutes east of UTC right now. */
    val offsetMinutes: Int,
    /** e.g. "UTC+07:00" */
    val offsetLabel: String,
    /** Local wall-clock time right now, e.g. "21:40". */
    val localTime: String,
)

object TimeZones {
    /** Every zone the web offers: UTC and tzdata's zone.tab, as canonical IANA names. */
    val ids: List<String> = listOf("UTC") + ZoneData.countries.keys

    /** Aliases by zone ("Cape Town" → Africa/Johannesburg). */
    private val aliasesByZone: Map<String, List<String>> by lazy {
        ZoneData.cityAliases.entries.groupBy({ it.value }, { it.key })
    }

    fun isKnown(id: String): Boolean = id == "UTC" || ZoneData.countries.containsKey(id)

    /**
     * The phone's zone as a canonical IANA name, or null when it cannot be told (some phones
     * report a bare offset, which is matched against the zone list).
     */
    fun detect(now: Instant = Instant.now()): String? {
        val id = ZoneId.systemDefault().id
        if (isKnown(id)) return id
        val offset = ZoneId.systemDefault().rules.getOffset(now).totalSeconds / 60
        return ids.firstOrNull { offsetOf(it, now) == offset }
    }

    private fun offsetOf(id: String, now: Instant): Int =
        runCatching { ZoneId.of(id).rules.getOffset(now).totalSeconds / 60 }.getOrDefault(0)

    /** The zone's country, city, current offset and local time. */
    fun describe(id: String, now: Instant = Instant.now(), locale: Locale = Locale.getDefault()): ZoneOption {
        val zone = runCatching { ZoneId.of(id) }.getOrElse { ZoneId.of("UTC") }
        val offsetMinutes = zone.rules.getOffset(now).totalSeconds / 60
        val countryCode = ZoneData.countries[id] ?: ""
        val country =
            if (countryCode.isEmpty()) ""
            else Locale.Builder().setRegion(countryCode).build().getDisplayCountry(locale)
        val city = if (id == "UTC") "UTC" else id.substringAfterLast('/').replace('_', ' ')
        val local = now.atZone(zone)
        val sign = if (offsetMinutes < 0) "-" else "+"
        val abs = abs(offsetMinutes)
        return ZoneOption(
            id = id,
            city = city,
            country = country,
            countryCode = countryCode,
            offsetMinutes = offsetMinutes,
            offsetLabel = "UTC%s%02d:%02d".format(sign, abs / 60, abs % 60),
            localTime = "%02d:%02d".format(local.hour, local.minute),
        )
    }

    /** "+7", "utc+7", "GMT+07:00", "-3:30" → minutes; null if it is not an offset query. */
    fun parseOffsetQuery(query: String): Int? {
        val m = Regex("^(?:utc|gmt)?\\s*([+-])\\s*(\\d{1,2})(?::?(\\d{2}))?$", RegexOption.IGNORE_CASE)
            .matchEntire(query.trim()) ?: return null
        val minutes = m.groupValues[2].toInt() * 60 + (m.groupValues[3].ifEmpty { "0" }.toInt())
        if (minutes > 14 * 60) return null
        return if (m.groupValues[1] == "+") minutes else -minutes
    }

    /** Lower case without accents, so "SÃO PAULO" matches "sao paulo". */
    private fun fold(s: String): String =
        Normalizer.normalize(s, Normalizer.Form.NFD).replace(Regex("\\p{Mn}+"), "").lowercase().trim()

    /**
     * Ranked search: every word must match something (city, country, alias, IANA name,
     * abbreviation); an offset query matches the zones at that offset right now.
     */
    fun search(
        query: String,
        now: Instant = Instant.now(),
        locale: Locale = Locale.getDefault(),
        limit: Int = 50,
    ): List<ZoneOption> {
        val all = ids.map { describe(it, now, locale) }
        val q = fold(query)
        if (q.isEmpty()) return all.sortedWith(compareBy({ it.offsetMinutes }, { it.city })).take(limit)

        val offset = parseOffsetQuery(query)
        if (offset != null) return all.filter { it.offsetMinutes == offset }.sortedBy { it.city }.take(limit)
        if (q == "utc" || q == "gmt") return all.filter { it.offsetMinutes == 0 }.sortedBy { it.city }.take(limit)

        val abbr = ZoneData.abbreviations[query.trim().uppercase()]
        // IANA names use underscores for spaces ("Phnom_Penh").
        val words = q.replace('_', ' ').split(Regex("\\s+")).filter { it.isNotEmpty() }
        val scored = mutableListOf<Pair<ZoneOption, Int>>()
        for (z in all) {
            val city = fold(z.city)
            val country = fold(z.country)
            val id = fold(z.id.replace('_', ' '))
            val aliases = aliasesByZone[z.id].orEmpty().map { fold(it) }
            var score = 0
            if (abbr?.contains(z.id) == true) score += 200
            var allWords = true
            for (w in words) {
                var best = 0
                if (city == w) best = maxOf(best, 120)
                if (city.startsWith(w)) best = maxOf(best, 100)
                if (aliases.any { it.startsWith(w) }) best = maxOf(best, 95)
                if (country.startsWith(w)) best = maxOf(best, 80)
                if (city.contains(w)) best = maxOf(best, 60)
                if (aliases.any { it.contains(w) }) best = maxOf(best, 55)
                if (country.contains(w)) best = maxOf(best, 50)
                if (id.contains(w)) best = maxOf(best, 40)
                if (best == 0) allWords = false
                score += best
            }
            if (allWords || (abbr?.contains(z.id) == true && words.size == 1)) scored += z to score
        }
        return scored.sortedWith(compareByDescending<Pair<ZoneOption, Int>> { it.second }.thenBy { it.first.city })
            .take(limit)
            .map { it.first }
    }
}
