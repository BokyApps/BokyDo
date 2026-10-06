import type { Template, TemplateSection, TemplateTask } from '@bokydo/shared';

/**
 * Starter templates that ship with BokyDo. They are plain templates (the same shape a CSV import
 * produces), written for this project and free to use. Dates are phrases ("every friday"), read
 * when a template is used, so "tomorrow" means tomorrow for whoever uses it.
 */
export interface GalleryTemplate {
  id: string;
  title: string;
  summary: string;
  template: Template;
}

type TaskOptions = Partial<Omit<TemplateTask, 'content'>>;

const task = (content: string, options: TaskOptions = {}): TemplateTask => ({
  content,
  description: '',
  priority: 4,
  depth: 0,
  date: null,
  timezone: null,
  durationMinutes: null,
  deadline: null,
  comments: [],
  ...options,
});
/** A sub-task, one level under the task before it. */
const sub = (content: string, options: TaskOptions = {}) => task(content, { depth: 1, ...options });
const section = (name: string, tasks: TemplateTask[]): TemplateSection => ({ name, tasks });
const template = (
  name: string,
  tasks: TemplateTask[],
  sections: TemplateSection[] = [],
): Template => ({ name, tasks, sections });

export const GALLERY: GalleryTemplate[] = [
  {
    id: 'getting-started',
    title: 'Getting started with BokyDo',
    summary: 'A tour of quick add, sub-tasks, sections, repeating tasks and priorities.',
    template: template(
      'Getting started',
      [],
      [
        section('Add tasks', [
          task('Press q to add a task from anywhere', {
            description: 'Try typing: Call mum tomorrow 5pm p1 @phone',
            date: 'today',
            priority: 1,
          }),
          task('Break a big task into sub-tasks', { date: 'tomorrow' }),
          sub('Press the sub-task button on a task'),
          sub('Drag it to change the order'),
        ]),
        section('Stay on top of it', [
          task('Water the plants', {
            description: 'Repeating tasks come back after you complete them.',
            date: 'every friday',
          }),
          task('Set a reminder on a task with a time', {
            description: 'Open a task, set a date with a time, then add a reminder.',
            date: 'tomorrow at 9am',
          }),
          task('Look at Today and Upcoming in the sidebar'),
        ]),
        section('Make it yours', [
          task('Pick a theme and font in Settings'),
          task('Save a filter such as: today | overdue'),
          task('Share a project with someone', {
            comments: ['Invite people from a project’s menu. Pick a role for each person.'],
          }),
        ]),
      ],
    ),
  },
  {
    id: 'weekly-review',
    title: 'Weekly review',
    summary: 'A short end-of-week routine: clear, plan, reflect.',
    template: template(
      'Weekly review',
      [],
      [
        section('Clear', [
          task('Empty your inbox', { date: 'every friday' }),
          task('Process loose notes and paper'),
          task('Look back at last week’s calendar'),
        ]),
        section('Plan', [
          task('Look ahead at next week’s calendar'),
          task('Pick the three things that matter most next week', { priority: 1 }),
          task('Check what you are waiting on from others'),
        ]),
        section('Reflect', [task('What went well this week?'), task('What would you change?')]),
      ],
    ),
  },
  {
    id: 'packing-list',
    title: 'Trip packing list',
    summary: 'Documents, clothes, toiletries and gadgets, ready to tick off.',
    template: template(
      'Trip packing list',
      [],
      [
        section('Documents', [
          task('Passport and visa', { priority: 1 }),
          task('Tickets and bookings'),
          task('Travel insurance'),
          task('Copies of important documents'),
        ]),
        section('Clothes', [
          task('Underwear and socks'),
          task('Tops and trousers'),
          task('Something warm'),
          task('Rain jacket'),
        ]),
        section('Toiletries', [
          task('Toothbrush and toothpaste'),
          task('Medication'),
          task('Sun cream'),
        ]),
        section('Electronics', [
          task('Phone and charger'),
          task('Power adapter'),
          task('Headphones'),
          task('Power bank'),
        ]),
      ],
    ),
  },
  {
    id: 'moving-house',
    title: 'Moving house',
    summary: 'What to do eight weeks out, four weeks out, in moving week and after.',
    template: template(
      'Moving house',
      [],
      [
        section('Eight weeks before', [
          task('Book a removal company or van', { priority: 1 }),
          task('Sort out what to keep, sell or give away'),
          task('Give notice to your landlord or list your home'),
        ]),
        section('Four weeks before', [
          task('Tell people your new address'),
          sub('Bank and credit cards'),
          sub('Employer and tax office'),
          sub('Insurance and utilities'),
          sub('Doctor and dentist'),
          task('Arrange internet at the new home'),
          task('Start packing rooms you rarely use'),
        ]),
        section('Moving week', [
          task('Pack an essentials box for the first night', { priority: 1 }),
          task('Take meter readings'),
          task('Defrost the freezer'),
          task('Hand over keys'),
        ]),
        section('After the move', [
          task('Unpack the kitchen and bedrooms first'),
          task('Update your address on your driving licence and registrations'),
          task('Meet the neighbours'),
        ]),
      ],
    ),
  },
  {
    id: 'onboarding',
    title: 'Welcome a new team member',
    summary: 'A checklist for the weeks around a new hire’s start.',
    template: template(
      'New team member',
      [],
      [
        section('Before day one', [
          task('Send a welcome message with the first-day plan', { priority: 1 }),
          task('Set up accounts and equipment'),
          task('Tell the team who is joining'),
        ]),
        section('Day one', [
          task('Welcome them in person or on a call'),
          task('Introduce the team'),
          task('Walk through tools and access'),
        ]),
        section('First week', [
          task('Agree what success looks like in the first month'),
          task('Pair them with a buddy'),
          task('Schedule daily check-ins', { date: 'every weekday' }),
        ]),
        section('First month', [
          task('Hold a feedback conversation', {
            comments: ['Ask what is working, what is confusing and what they need.'],
          }),
          task('Review the first-month goals'),
        ]),
      ],
    ),
  },
  {
    id: 'home-maintenance',
    title: 'Home maintenance',
    summary: 'Repeating chores so nothing around the house is forgotten.',
    template: template('Home maintenance', [
      task('Test the smoke detectors', { date: 'every month' }),
      task('Clean the bathroom extractor fan', { date: 'every 3 months' }),
      task('Replace the water filter', { date: 'every 3 months' }),
      task('Clear the gutters', { date: 'every 6 months' }),
      task('Service the boiler', { date: 'every year' }),
      task('Check the fire extinguisher', { date: 'every year' }),
      task('Back up photos and documents', { date: 'every month' }),
    ]),
  },
  {
    id: 'event-planning',
    title: 'Plan an event',
    summary: 'From the guest list to the thank-you notes.',
    template: template(
      'Event',
      [],
      [
        section('Plan', [
          task('Decide the date, budget and guest count', { priority: 1 }),
          task('Choose and book a venue'),
          task('Plan food and drink'),
        ]),
        section('Invite', [
          task('Write the guest list'),
          task('Send invitations'),
          task('Chase replies'),
        ]),
        section('Logistics', [
          task('Arrange music or entertainment'),
          task('Organise help on the day'),
          task('Make a running order'),
        ]),
        section('After', [task('Settle the bills'), task('Send thank-you notes')]),
      ],
    ),
  },
  {
    id: 'meeting',
    title: 'Run a meeting well',
    summary: 'Prepare, run and follow up, in that order.',
    template: template('Meeting', [
      task('Write down the goal of the meeting', { priority: 1 }),
      task('Draft the agenda'),
      task('Send the agenda and any reading ahead of time'),
      task('Run the meeting'),
      sub('Start on time'),
      sub('Take notes and write down decisions'),
      sub('Agree an owner and a date for each action'),
      task('Send the notes and action items', { date: 'tomorrow' }),
    ]),
  },
  {
    id: 'blog-post',
    title: 'Write and publish a post',
    summary: 'Idea to published, with an edit pass in the middle.',
    template: template(
      'Blog post',
      [],
      [
        section('Idea', [task('Capture the idea in one sentence'), task('Note who it is for')]),
        section('Draft', [
          task('Outline the main points'),
          task('Write a rough first draft'),
          task('Add examples and links'),
        ]),
        section('Edit', [
          task('Let it rest, then read it aloud'),
          task('Cut a third'),
          task('Check facts and links'),
        ]),
        section('Publish', [task('Pick a title and a picture'), task('Publish'), task('Share it')]),
      ],
    ),
  },
];
