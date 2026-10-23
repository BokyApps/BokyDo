package com.bokyapps.bokydo.core

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.time.Instant

class TimeZonesTest {
    private val now = Instant.parse("2026-10-22T12:00:00Z")

    private fun search(query: String) = TimeZones.search(query, now = now, limit = 20)

    @Test
    fun findsZonesByCityCountryAndIanaName() {
        assertEquals("Asia/Phnom_Penh", search("phnom penh").first().id)
        assertEquals("Asia/Phnom_Penh", search("Phnom Penh").first().id)
        assertEquals("Asia/Bangkok", search("asia/bangkok").first().id)
        assertEquals("Europe/Berlin", search("germany").first().id)
    }

    @Test
    fun findsTheCitiesThatShareAnotherCitysZone() {
        assertEquals("Africa/Johannesburg", search("cape town").first().id)
        assertEquals("Africa/Johannesburg", search("pretoria").first().id)
        assertEquals("Asia/Kolkata", search("mumbai").first().id)
    }

    @Test
    fun findsZonesByAbbreviation() {
        val sast = search("SAST")
        assertEquals("Africa/Johannesburg", sast.first().id)
        assertEquals(listOf("Africa/Johannesburg"), sast.map { it.id })
        // The daylight-saving spellings point at the same zones.
        val cest = search("CEST").map { it.id }
        assertTrue(cest.contains("Europe/Berlin"))
        assertTrue(cest.contains("Europe/Amsterdam"))
    }

    @Test
    fun findsZonesByOffsetInAnySpelling() {
        assertEquals(420, TimeZones.parseOffsetQuery("+7"))
        assertEquals(420, TimeZones.parseOffsetQuery("utc+7"))
        assertEquals(420, TimeZones.parseOffsetQuery("GMT+07:00"))
        assertEquals(-210, TimeZones.parseOffsetQuery("-3:30"))
        assertNull(TimeZones.parseOffsetQuery("phnom penh"))
        val plusSeven = search("+7")
        assertEquals(420, plusSeven.first().offsetMinutes)
        assertTrue(plusSeven.all { it.offsetMinutes == 420 })
    }

    @Test
    fun describesTheZoneWithItsOffsetAndLocalTime() {
        val zone = TimeZones.describe("Asia/Phnom_Penh", now)
        assertEquals("Phnom Penh", zone.city)
        assertEquals("Cambodia", zone.country)
        assertEquals("KH", zone.countryCode)
        assertEquals("UTC+07:00", zone.offsetLabel)
        assertEquals("19:00", zone.localTime)
        assertEquals("UTC+00:00", TimeZones.describe("UTC", now).offsetLabel)
    }

    @Test
    fun everyOfferedZoneIsOneTheServerAccepts() {
        assertTrue(TimeZones.ids.isNotEmpty())
        for (id in TimeZones.ids) assertTrue(TimeZones.isKnown(id))
        // The web only stores the zones it knows, so the picker must not offer others.
        assertEquals(TimeZones.ids.distinct().size, TimeZones.ids.size)
    }

    private fun assertTrue(value: Boolean) = org.junit.Assert.assertTrue(value)
}
