import { describe, expect, it } from 'vitest';
import { parseDate, parseQuickAdd, type ParsedDue, type QuickAddOptions } from './quick-add.js';

/**
 * Golden corpus. Every phrase is checked on its own (the date picker) and inside several
 * quick-add sentences, so each row yields six cases. "Now" is Monday 5 October 2026, 10:00.
 *
 * Expected values: `date [time] [| rrule [| completion]]`, or null when the phrase must stay text.
 * Flags: `end` = a bare adverb that only counts at the end of the text ("Team sync weekly");
 * `standalone` = needs a preposition inside a sentence ("on the 20th"), works on its own.
 */
type Row = [phrase: string, expected: string | null, flag?: 'end' | 'standalone'];

const NOW = { date: '2026-10-05', time: '10:00' };
const OPTIONS: QuickAddOptions = {
  now: NOW,
  weekStart: 'monday',
  dateOrder: 'dmy',
  projects: [{ id: 'work', name: 'Work' }],
};

const DATES: Row[] = [
  // Relative days
  ['today', '2026-10-05'],
  ['tod', '2026-10-05'],
  ['tonight', '2026-10-05 19:00'],
  ['tomorrow', '2026-10-06'],
  ['tmr', '2026-10-06'],
  ['tmrw', '2026-10-06'],
  ['yesterday', '2026-10-04'],
  ['day after tomorrow', '2026-10-07'],
  ['the day after tomorrow', '2026-10-07'],
  ['tomorrow morning', '2026-10-06 09:00'],
  ['tomorrow afternoon', '2026-10-06 14:00'],
  ['tomorrow evening', '2026-10-06 19:00'],
  ['tomorrow night', '2026-10-06 21:00'],
  ['tomorrow in the morning', '2026-10-06 09:00'],
  ['this morning', '2026-10-05 09:00'],
  ['this afternoon', '2026-10-05 14:00'],
  ['this evening', '2026-10-05 19:00'],
  // Times
  ['today at 5pm', '2026-10-05 17:00'],
  ['tomorrow at 5pm', '2026-10-06 17:00'],
  ['tomorrow 5pm', '2026-10-06 17:00'],
  ['5pm tomorrow', '2026-10-06 17:00'],
  ['at 5pm tomorrow', '2026-10-06 17:00'],
  ['tomorrow at 17:00', '2026-10-06 17:00'],
  ['tomorrow 9am', '2026-10-06 09:00'],
  ['tomorrow at 9:30am', '2026-10-06 09:30'],
  ['tomorrow 9:30 am', '2026-10-06 09:30'],
  ['tomorrow at noon', '2026-10-06 12:00'],
  ['tomorrow at midnight', '2026-10-06 00:00'],
  ['tomorrow 12am', '2026-10-06 00:00'],
  ['tomorrow 12pm', '2026-10-06 12:00'],
  ['tomorrow at 9', '2026-10-06 09:00'],
  ['tomorrow at 21', '2026-10-06 21:00'],
  ['tonight at 8', '2026-10-05 20:00'],
  ['this evening at 7', '2026-10-05 19:00'],
  ['tomorrow evening at 8', '2026-10-06 20:00'],
  ['tomorrow afternoon at 3', '2026-10-06 15:00'],
  ['tomorrow morning at 7', '2026-10-06 07:00'],
  ['at 5pm', '2026-10-05 17:00'],
  ['5pm', '2026-10-05 17:00'],
  ['17:00', '2026-10-05 17:00'],
  ['at 17:30', '2026-10-05 17:30'],
  ['at noon', '2026-10-05 12:00'],
  ['noon', '2026-10-05 12:00'],
  ['at midnight', '2026-10-05 00:00'],
  ['at 9', '2026-10-05 09:00'],
  ['9:45pm', '2026-10-05 21:45'],
  ['at 11:15', '2026-10-05 11:15'],
  ['5.30pm', '2026-10-05 17:30'],
  ['5 pm', '2026-10-05 17:00'],
  ['at 5 p.m', '2026-10-05 17:00'],
  ['at 7 am', '2026-10-05 07:00'],
  ['at 6 o’clock', '2026-10-05 06:00'],
  ["at 6 o'clock", '2026-10-05 06:00'],
  ['11pm', '2026-10-05 23:00'],
  ['1am', '2026-10-05 01:00'],
  ['00:30', '2026-10-05 00:30'],
  // Weekdays
  ['monday', '2026-10-05'],
  ['mon', '2026-10-05'],
  ['tuesday', '2026-10-06'],
  ['tue', '2026-10-06'],
  ['tues', '2026-10-06'],
  ['wednesday', '2026-10-07'],
  ['thursday', '2026-10-08'],
  ['thu', '2026-10-08'],
  ['thur', '2026-10-08'],
  ['thurs', '2026-10-08'],
  ['friday', '2026-10-09'],
  ['fri', '2026-10-09'],
  ['saturday', '2026-10-10'],
  ['sunday', '2026-10-11'],
  ['on sat', '2026-10-10'],
  ['on sun', '2026-10-11'],
  ['on wed', '2026-10-07'],
  ['sat', '2026-10-10', 'standalone'],
  ['wed', '2026-10-07', 'standalone'],
  ['this fri', '2026-10-09'],
  ['this monday', '2026-10-05'],
  ['this sat', '2026-10-10'],
  ['coming monday', '2026-10-12'],
  ['coming fri', '2026-10-09'],
  ['next mon', '2026-10-12'],
  ['next monday', '2026-10-12'],
  ['next fri', '2026-10-16'],
  ['next friday', '2026-10-16'],
  ['next sunday', '2026-10-18'],
  ['next wed', '2026-10-14'],
  ['next sat', '2026-10-17'],
  ['on friday', '2026-10-09'],
  ['by friday', '2026-10-09'],
  ['due friday', '2026-10-09'],
  ['due on friday', '2026-10-09'],
  ['friday at 3pm', '2026-10-09 15:00'],
  ['fri 3pm', '2026-10-09 15:00'],
  ['3pm fri', '2026-10-09 15:00'],
  ['at 3pm on friday', '2026-10-09 15:00'],
  ['friday evening', '2026-10-09 19:00'],
  ['monday morning', '2026-10-05 09:00'],
  ['next friday at 10am', '2026-10-16 10:00'],
  ['fri oct 9', '2026-10-09'],
  ['friday 9 oct', '2026-10-09'],
  ['monday 12/10', '2026-10-12'],
  ['fri oct 9 3pm', '2026-10-09 15:00'],
  // Weeks, months, years
  ['next week', '2026-10-12'],
  ['next month', '2026-11-01'],
  ['next year', '2027-01-01'],
  ['this weekend', '2026-10-10'],
  ['next weekend', '2026-10-17'],
  ['next march', '2027-03-01'],
  ['next november', '2026-11-01'],
  // Relative amounts
  ['in 3 days', '2026-10-08'],
  ['in a day', '2026-10-06'],
  ['in 2 weeks', '2026-10-19'],
  ['in a week', '2026-10-12'],
  ['in 1 month', '2026-11-05'],
  ['in 3 months', '2027-01-05'],
  ['in a year', '2027-10-05'],
  ['in 2 years', '2028-10-05'],
  ['in 3d', '2026-10-08'],
  ['in 2w', '2026-10-19'],
  ['in 2 hours', '2026-10-05 12:00'],
  ['in 30 minutes', '2026-10-05 10:30'],
  ['in 30min', '2026-10-05 10:30'],
  ['in 90 min', '2026-10-05 11:30'],
  ['in an hour', '2026-10-05 11:00'],
  ['in half an hour', '2026-10-05 10:30'],
  ['in 15m', '2026-10-05 10:15'],
  ['in 14 hours', '2026-10-06 00:00'],
  ['3 days from now', '2026-10-08'],
  ['2 weeks later', '2026-10-19'],
  ['in five days', '2026-10-10'],
  ['in twelve days', '2026-10-17'],
  ['in 10 days', '2026-10-15'],
  ['in 100 days', '2027-01-13'],
  // Period boundaries
  ['end of month', '2026-10-31'],
  ['eom', '2026-10-31'],
  ['end of the month', '2026-10-31'],
  ['end of next month', '2026-11-30'],
  ['end of week', '2026-10-09'],
  ['eow', '2026-10-09'],
  ['end of the week', '2026-10-09'],
  ['end of next week', '2026-10-16'],
  ['end of year', '2026-12-31'],
  ['eoy', '2026-12-31'],
  ['end of next year', '2027-12-31'],
  ['end of march', '2027-03-31'],
  ['end of oct', '2026-10-31'],
  ['end of feb', '2027-02-28'],
  ['mid month', '2026-10-15'],
  ['mid next month', '2026-11-15'],
  ['middle of the month', '2026-10-15'],
  ['mid march', '2027-03-15'],
  ['mid-march', '2027-03-15'],
  ['mid october', '2026-10-15'],
  ['mid oct', '2026-10-15'],
  ['beginning of next month', '2026-11-01'],
  ['start of next month', '2026-11-01'],
  ['start of next week', '2026-10-12'],
  ['beginning of next week', '2026-10-12'],
  ['start of next year', '2027-01-01'],
  ['beginning of march', '2027-03-01'],
  ['start of november', '2026-11-01'],
  // Explicit dates
  ['jan 27', '2027-01-27'],
  ['january 27', '2027-01-27'],
  ['jan 27th', '2027-01-27'],
  ['27 jan', '2027-01-27'],
  ['27th jan', '2027-01-27'],
  ['27th of january', '2027-01-27'],
  ['the 27th of january', '2027-01-27'],
  ['jan 27 2028', '2028-01-27'],
  ['jan 27, 2028', '2028-01-27'],
  ['27 january 2028', '2028-01-27'],
  ['oct 20', '2026-10-20'],
  ['oct 5', '2026-10-05'],
  ['oct 4', '2027-10-04'],
  ['dec 25', '2026-12-25'],
  ['25 dec', '2026-12-25'],
  ['25 december 2026', '2026-12-25'],
  ['december 25th', '2026-12-25'],
  ['sept 1', '2027-09-01'],
  ['may 3', '2027-05-03'],
  ['3 may', '2027-05-03'],
  ['mar 15', '2027-03-15'],
  ['feb 29', '2028-02-29'],
  ['feb 29 2027', null],
  ['feb 30', null],
  ['27/10', '2026-10-27'],
  ['27/10/2027', '2027-10-27'],
  ['27/10/27', '2027-10-27'],
  ['1/2', '2027-02-01'],
  ['31/12', '2026-12-31'],
  ['5/10', '2026-10-05'],
  ['2026-12-01', '2026-12-01'],
  ['2027-01-15', '2027-01-15'],
  ['2026/10/27', '2026-10-27'],
  ['27.10.2026', '2026-10-27'],
  ['31/2', null],
  ['13/13', null],
  ['2026-02-30', null],
  ['on the 20th', '2026-10-20'],
  ['on the 3rd', '2026-11-03'],
  ['by the 31st', '2026-10-31'],
  ['on the 5th', '2026-10-05'],
  ['on 15th', '2026-10-15'],
  ['the 20th', '2026-10-20', 'standalone'],
  ['20th', '2026-10-20', 'standalone'],
  ['on jan 27', '2027-01-27'],
  ['by dec 1', '2026-12-01'],
  ['on 27/10', '2026-10-27'],
  ['jan 27 at 9am', '2027-01-27 09:00'],
  ['27/10 14:00', '2026-10-27 14:00'],
  ['27 oct at 2:30pm', '2026-10-27 14:30'],
  ['2pm on 27 oct', '2026-10-27 14:00'],
];

const RECURRING: Row[] = [
  ['every day', '2026-10-05 | FREQ=DAILY'],
  ['daily', '2026-10-05 | FREQ=DAILY', 'end'],
  ['every night', '2026-10-05 21:00 | FREQ=DAILY'],
  ['every morning', '2026-10-06 09:00 | FREQ=DAILY'],
  ['every evening', '2026-10-05 19:00 | FREQ=DAILY'],
  ['every afternoon', '2026-10-05 14:00 | FREQ=DAILY'],
  ['each day', '2026-10-05 | FREQ=DAILY'],
  ['every other day', '2026-10-05 | FREQ=DAILY;INTERVAL=2'],
  ['every 3 days', '2026-10-05 | FREQ=DAILY;INTERVAL=3'],
  ['every 3d', '2026-10-05 | FREQ=DAILY;INTERVAL=3'],
  ['every two days', '2026-10-05 | FREQ=DAILY;INTERVAL=2'],
  ['every week', '2026-10-05 | FREQ=WEEKLY;BYDAY=MO'],
  ['weekly', '2026-10-05 | FREQ=WEEKLY;BYDAY=MO', 'end'],
  ['every other week', '2026-10-05 | FREQ=WEEKLY;INTERVAL=2;BYDAY=MO'],
  ['every 2 weeks', '2026-10-05 | FREQ=WEEKLY;INTERVAL=2;BYDAY=MO'],
  ['fortnightly', '2026-10-05 | FREQ=WEEKLY;INTERVAL=2;BYDAY=MO', 'end'],
  ['biweekly', '2026-10-05 | FREQ=WEEKLY;INTERVAL=2;BYDAY=MO', 'end'],
  ['every weekday', '2026-10-05 | FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR'],
  ['every workday', '2026-10-05 | FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR'],
  ['every weekend', '2026-10-10 | FREQ=WEEKLY;BYDAY=SA,SU'],
  ['every mon', '2026-10-05 | FREQ=WEEKLY;BYDAY=MO'],
  ['every monday', '2026-10-05 | FREQ=WEEKLY;BYDAY=MO'],
  ['every mondays', '2026-10-05 | FREQ=WEEKLY;BYDAY=MO'],
  ['every fri', '2026-10-09 | FREQ=WEEKLY;BYDAY=FR'],
  ['every sat', '2026-10-10 | FREQ=WEEKLY;BYDAY=SA'],
  ['every sun', '2026-10-11 | FREQ=WEEKLY;BYDAY=SU'],
  ['every wed', '2026-10-07 | FREQ=WEEKLY;BYDAY=WE'],
  ['every tue and thu', '2026-10-06 | FREQ=WEEKLY;BYDAY=TU,TH'],
  ['every mon, wed, fri', '2026-10-05 | FREQ=WEEKLY;BYDAY=MO,WE,FR'],
  ['every mon,wed,fri', '2026-10-05 | FREQ=WEEKLY;BYDAY=MO,WE,FR'],
  ['every mon, wed and fri', '2026-10-05 | FREQ=WEEKLY;BYDAY=MO,WE,FR'],
  ['every mon & fri', '2026-10-05 | FREQ=WEEKLY;BYDAY=MO,FR'],
  ['every sat and sun', '2026-10-10 | FREQ=WEEKLY;BYDAY=SA,SU'],
  ['every other mon', '2026-10-05 | FREQ=WEEKLY;INTERVAL=2;BYDAY=MO'],
  ['every other fri', '2026-10-09 | FREQ=WEEKLY;INTERVAL=2;BYDAY=FR'],
  ['every 2 weeks on fri', '2026-10-09 | FREQ=WEEKLY;INTERVAL=2;BYDAY=FR'],
  ['every 3 weeks on tue, thu', '2026-10-06 | FREQ=WEEKLY;INTERVAL=3;BYDAY=TU,TH'],
  ['every week on wed', '2026-10-07 | FREQ=WEEKLY;BYDAY=WE'],
  ['every mon at 9am', '2026-10-12 09:00 | FREQ=WEEKLY;BYDAY=MO'],
  ['every mon 9am', '2026-10-12 09:00 | FREQ=WEEKLY;BYDAY=MO'],
  ['every mon at 11am', '2026-10-05 11:00 | FREQ=WEEKLY;BYDAY=MO'],
  ['every fri at 5pm', '2026-10-09 17:00 | FREQ=WEEKLY;BYDAY=FR'],
  ['every day at 9am', '2026-10-06 09:00 | FREQ=DAILY'],
  ['every day 11am', '2026-10-05 11:00 | FREQ=DAILY'],
  ['every day at 10:00', '2026-10-06 10:00 | FREQ=DAILY'],
  ['every day at noon', '2026-10-05 12:00 | FREQ=DAILY'],
  ['every weekday at 8:30', '2026-10-06 08:30 | FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR'],
  ['every month', '2026-10-05 | FREQ=MONTHLY;BYMONTHDAY=5'],
  ['monthly', '2026-10-05 | FREQ=MONTHLY;BYMONTHDAY=5', 'end'],
  ['every other month', '2026-10-05 | FREQ=MONTHLY;INTERVAL=2;BYMONTHDAY=5'],
  ['every 3 months', '2026-10-05 | FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=5'],
  ['quarterly', '2026-10-05 | FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=5', 'end'],
  ['every year', '2026-10-05 | FREQ=YEARLY;BYMONTH=10;BYMONTHDAY=5'],
  ['yearly', '2026-10-05 | FREQ=YEARLY;BYMONTH=10;BYMONTHDAY=5', 'end'],
  ['annually', '2026-10-05 | FREQ=YEARLY;BYMONTH=10;BYMONTHDAY=5', 'end'],
  ['every 2 years', '2026-10-05 | FREQ=YEARLY;INTERVAL=2;BYMONTH=10;BYMONTHDAY=5'],
  ['every 1st', '2026-11-01 | FREQ=MONTHLY;BYMONTHDAY=1'],
  ['every 15th', '2026-10-15 | FREQ=MONTHLY;BYMONTHDAY=15'],
  ['every 31st', '2026-10-31 | FREQ=MONTHLY;BYMONTHDAY=31'],
  ['every 5th', '2026-10-05 | FREQ=MONTHLY;BYMONTHDAY=5'],
  ['every 4th', '2026-11-04 | FREQ=MONTHLY;BYMONTHDAY=4'],
  ['every 27', '2026-10-27 | FREQ=MONTHLY;BYMONTHDAY=27'],
  ['every last day', '2026-10-31 | FREQ=MONTHLY;BYMONTHDAY=-1'],
  ['every last day of the month', '2026-10-31 | FREQ=MONTHLY;BYMONTHDAY=-1'],
  ['every first day', '2026-11-01 | FREQ=MONTHLY;BYMONTHDAY=1'],
  ['every 1st of the month', '2026-11-01 | FREQ=MONTHLY;BYMONTHDAY=1'],
  ['every 15th of every month', '2026-10-15 | FREQ=MONTHLY;BYMONTHDAY=15'],
  ['every 2nd mon', '2026-10-12 | FREQ=MONTHLY;BYDAY=2MO'],
  ['every second monday', '2026-10-12 | FREQ=MONTHLY;BYDAY=2MO'],
  ['every first monday', '2026-10-05 | FREQ=MONTHLY;BYDAY=1MO'],
  ['every last fri', '2026-10-30 | FREQ=MONTHLY;BYDAY=-1FR'],
  ['every last friday of the month', '2026-10-30 | FREQ=MONTHLY;BYDAY=-1FR'],
  ['every 3rd wed', '2026-10-21 | FREQ=MONTHLY;BYDAY=3WE'],
  ['every first sat', '2026-11-07 | FREQ=MONTHLY;BYDAY=1SA'],
  ['every 2nd tue', '2026-10-13 | FREQ=MONTHLY;BYDAY=2TU'],
  ['every month on the 15th', '2026-10-15 | FREQ=MONTHLY;BYMONTHDAY=15'],
  ['every month on the last fri', '2026-10-30 | FREQ=MONTHLY;BYDAY=-1FR'],
  ['every month on the 2nd tue', '2026-10-13 | FREQ=MONTHLY;BYDAY=2TU'],
  ['every 2 months on the 1st', '2026-11-01 | FREQ=MONTHLY;INTERVAL=2;BYMONTHDAY=1'],
  ['every jan 27', '2027-01-27 | FREQ=YEARLY;BYMONTH=1;BYMONTHDAY=27'],
  ['every 27 jan', '2027-01-27 | FREQ=YEARLY;BYMONTH=1;BYMONTHDAY=27'],
  ['every 27th of january', '2027-01-27 | FREQ=YEARLY;BYMONTH=1;BYMONTHDAY=27'],
  ['every dec 25', '2026-12-25 | FREQ=YEARLY;BYMONTH=12;BYMONTHDAY=25'],
  ['every oct 5', '2026-10-05 | FREQ=YEARLY;BYMONTH=10;BYMONTHDAY=5'],
  ['every oct 1', '2027-10-01 | FREQ=YEARLY;BYMONTH=10;BYMONTHDAY=1'],
  ['every hour', '2026-10-05 11:00 | FREQ=HOURLY'],
  ['hourly', '2026-10-05 11:00 | FREQ=HOURLY', 'end'],
  ['every 2 hours', '2026-10-05 11:00 | FREQ=HOURLY;INTERVAL=2'],
  ['every 4 hours starting 9am', '2026-10-05 13:00 | FREQ=HOURLY;INTERVAL=4'],
  ['every hour starting at 2pm', '2026-10-05 14:00 | FREQ=HOURLY'],
  ['every! day', '2026-10-05 | FREQ=DAILY | completion'],
  ['every! 3 days', '2026-10-05 | FREQ=DAILY;INTERVAL=3 | completion'],
  ['every! week', '2026-10-05 | FREQ=WEEKLY | completion'],
  ['every! 2 weeks', '2026-10-05 | FREQ=WEEKLY;INTERVAL=2 | completion'],
  ['every! month', '2026-10-05 | FREQ=MONTHLY | completion'],
  ['every! mon', '2026-10-05 | FREQ=WEEKLY;BYDAY=MO | completion'],
  ['every! 3 months', '2026-10-05 | FREQ=MONTHLY;INTERVAL=3 | completion'],
  ['every day starting tomorrow', '2026-10-06 | FREQ=DAILY'],
  ['every day from tomorrow', '2026-10-06 | FREQ=DAILY'],
  ['every mon starting next week', '2026-10-12 | FREQ=WEEKLY;BYDAY=MO'],
  ['every 3 months starting aug', '2027-08-01 | FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=1'],
  ['every fri starting nov 1', '2026-11-06 | FREQ=WEEKLY;BYDAY=FR'],
  ['every day until oct 10', '2026-10-05 | FREQ=DAILY;UNTIL=20261010'],
  ['every mon until dec 1', '2026-10-05 | FREQ=WEEKLY;BYDAY=MO;UNTIL=20261201'],
  ['every weekday until oct 9', '2026-10-05 | FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;UNTIL=20261009'],
  ['every other week starting next fri', '2026-10-16 | FREQ=WEEKLY;INTERVAL=2;BYDAY=FR'],
  ['every day at 9am starting next mon', '2026-10-12 09:00 | FREQ=DAILY'],
  ['every day starting next mon at 9am', '2026-10-12 09:00 | FREQ=DAILY'],
  ['every 2nd mon starting nov', '2026-11-09 | FREQ=MONTHLY;BYDAY=2MO'],
  [
    'every 3 months starting aug until dec 2027',
    '2027-08-01 | FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=1;UNTIL=20271231',
  ],
];

/** Phrases that must never become dates inside a sentence. */
const NOT_DATES = [
  'Weekly review',
  'Read chapter 5',
  'Buy 2 apples',
  'Fix the sun shade',
  'Wed planning',
  'Sat exam prep',
  'May the force be with you',
  'March forward',
  'Version 1.5 release',
  'Room 101',
  'Second thoughts',
  'Last call',
  'Everyone meeting',
  'Every one of them',
  'Every so often',
  'Mon-Fri planning',
  'Read 3 chapters',
  'Total 5.30',
  'The 3rd draft',
  'Meet at the cafe',
  'Monthly budget',
  'Daily standup notes',
  'Call 555-1234',
  'Water for 3 days',
  'Plan the weekend',
  'Next steps',
  'Every!thing',
  'In progress',
  'Sun cream',
  'Dec tree',
];

function encode(due: ParsedDue | null): string | null {
  if (!due) return null;
  let s = due.time ? `${due.date} ${due.time}` : due.date;
  if (due.recurrence) {
    s += ` | ${due.recurrence.rrule}`;
    if (due.recurrence.anchor === 'completion') s += ' | completion';
  }
  return s;
}

function sentences(row: Row) {
  const [p, expected, flag] = row;
  const inSentence = flag === 'standalone' ? null : expected;
  // A trailing adverb only counts before other tokens or at the end.
  const midSentence = flag === 'end' ? null : inSentence;
  const keepsPhrase = (s: string) => (inSentence ? '' : ` ${p}`) + s;
  return [
    { input: `Task ${p}`, content: `Task${keepsPhrase('')}`, due: inSentence },
    {
      input: `${p} task`,
      content: midSentence ? 'task' : `${p} task`,
      due: midSentence,
    },
    {
      input: `Call Alex ${p} #Work p2 @calls`,
      content: `Call Alex${keepsPhrase('')}`,
      due: inSentence,
      extra: { projectId: 'work', priority: 2, labels: ['calls'] },
    },
    {
      input: `Buy milk ${p} for 30min`,
      content: midSentence ? 'Buy milk' : `Buy milk ${p}`,
      due: midSentence,
      extra: { durationMinutes: 30 },
    },
    {
      input: `Submit form ${p}.`,
      content: `Submit form${keepsPhrase('')}.`,
      due: inSentence,
    },
  ];
}

const ALL = [...DATES, ...RECURRING];

describe('golden corpus', () => {
  it('has at least 1,500 cases', () => {
    expect(ALL.length * 6 + NOT_DATES.length).toBeGreaterThanOrEqual(1500);
  });

  describe('standalone (date picker)', () => {
    it.each(ALL)('%s', (phrase, expected) => {
      expect(encode(parseDate(phrase, OPTIONS))).toBe(expected);
    });
  });

  describe('in quick add', () => {
    const cases = ALL.flatMap((row) => sentences(row).map((c) => [c.input, c] as const));
    it.each(cases)('%s', (_, c) => {
      const r = parseQuickAdd(c.input, OPTIONS);
      expect(encode(r.due)).toBe(c.due);
      expect(r.content).toBe(c.content.replace(/\s+/g, ' ').replace(/ \./g, '.'));
      if (c.extra) expect(r).toMatchObject(c.extra);
      if (r.due) expect(r.due.string.length).toBeGreaterThan(0);
    });
  });

  describe('ordinary titles stay text', () => {
    it.each(NOT_DATES)('%s', (title) => {
      const r = parseQuickAdd(title, OPTIONS);
      expect(r.due).toBeNull();
      expect(r.content).toBe(title);
    });
  });
});

describe('preferences', () => {
  it('reads numeric dates month-first for mdy users', () => {
    const mdy = { ...OPTIONS, dateOrder: 'mdy' as const };
    expect(parseDate('10/27', mdy)?.date).toBe('2026-10-27');
    expect(parseDate('1/2', mdy)?.date).toBe('2027-01-02');
    expect(parseDate('12/25/2026', mdy)?.date).toBe('2026-12-25');
    expect(parseDate('27/10', mdy)).toBeNull();
  });

  it('only reads bare adverbs at the end of the text', () => {
    expect(parseQuickAdd('Stretch daily at 8', OPTIONS).due).toMatchObject({
      date: '2026-10-06',
      time: '08:00',
      recurrence: { rrule: 'FREQ=DAILY' },
    });
    expect(parseQuickAdd('Stretch daily #Work', OPTIONS).due?.recurrence?.rrule).toBe('FREQ=DAILY');
    expect(parseQuickAdd('Daily standup', OPTIONS).due).toBeNull();
  });

  it('drops a series that ends before it starts', () => {
    expect(parseDate('every day until yesterday', OPTIONS)).toBeNull();
  });

  it('uses the week start for "next week" and "next <day>"', () => {
    const sunday = { ...OPTIONS, weekStart: 'sunday' as const };
    expect(parseDate('next week', sunday)?.date).toBe('2026-10-11');
    expect(parseDate('next mon', sunday)?.date).toBe('2026-10-12');
    expect(parseDate('next sun', sunday)?.date).toBe('2026-10-11');
  });

  it('rolls dates across month and year ends', () => {
    const nye = { ...OPTIONS, now: { date: '2026-12-31', time: '23:30' } };
    expect(parseDate('tomorrow', nye)?.date).toBe('2027-01-01');
    expect(parseDate('in 1 hour', nye)).toMatchObject({ date: '2027-01-01', time: '00:30' });
    expect(parseDate('next month', nye)?.date).toBe('2027-01-01');
    expect(parseDate('end of month', nye)?.date).toBe('2026-12-31');
    expect(parseDate('mid month', nye)?.date).toBe('2027-01-15');
    expect(parseDate('jan 1', nye)?.date).toBe('2027-01-01');
    const leap = { ...OPTIONS, now: { date: '2028-01-31', time: '09:00' } };
    expect(parseDate('in 1 month', leap)?.date).toBe('2028-02-29');
    expect(parseDate('every month', leap)?.recurrence?.rrule).toBe('FREQ=MONTHLY;BYMONTHDAY=31');
  });
});
