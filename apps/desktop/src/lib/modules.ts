// Every area of the app, for the Dashboard tiles and the More page (the top
// bar only carries Dashboard, Jobs, Invoicing, Analytics and More).

export interface AppModule {
  to: string;
  label: string;
  icon: string;
  blurb: string;
}

export const MODULES = {
  jobs: { to: "/jobs", label: "Jobs", icon: "🧰", blurb: "Every job, its stage and the job card" },
  dispatch: { to: "/dispatch", label: "Dispatch", icon: "🗺️", blurb: "Book jobs onto the team's day" },
  calendar: { to: "/calendar", label: "Calendar", icon: "📅", blurb: "Bookings and events, synced with Google" },
  tasks: { to: "/tasks", label: "Tasks", icon: "✅", blurb: "To-dos, projects and the matrix" },
  timesheets: { to: "/analytics/timesheets/mine", label: "Timesheets", icon: "⏱️", blurb: "Hours worked and approvals" },
  reports: { to: "/reports", label: "Forms & Certificates", icon: "📋", blurb: "Inspection reports and certificates" },
  subcontractors: { to: "/subcontractors", label: "Subcontractors", icon: "🦺", blurb: "Subbies, compliance and purchase orders" },
  clients: { to: "/clients", label: "Clients", icon: "👤", blurb: "Clients, contacts and addresses" },
  quotes: { to: "/quotes", label: "Quotes", icon: "📝", blurb: "Quotes and approvals" },
  invoices: { to: "/invoices", label: "Invoices", icon: "💲", blurb: "Invoices and payments" },
  priceBook: { to: "/price-book", label: "Price Book", icon: "📦", blurb: "Items and services you sell" },
  assets: { to: "/assets", label: "Assets", icon: "🚿", blurb: "Installed assets, services and warranties" },
  followUps: { to: "/follow-ups", label: "Follow-ups", icon: "🔁", blurb: "Automatic follow-up texts" },
  membership: { to: "/membership", label: "Membership", icon: "🎟️", blurb: "Member plans and benefits" },
  googleReviews: { to: "/google-reviews", label: "Google Reviews", icon: "⭐", blurb: "Review requests and ratings" },
  referrals: { to: "/b2b-referrals", label: "B2B & Referrals", icon: "🤝", blurb: "Referral partners and fees" },
  realEstate: { to: "/real-estate", label: "Real Estate & Strata", icon: "🏢", blurb: "Agencies, properties and maintenance" },
  channels: { to: "/channels", label: "Channels", icon: "💬", blurb: "SMS, WhatsApp and Messenger" },
  inbox: { to: "/inbox", label: "Inbox", icon: "📥", blurb: "Emails turned into jobs" },
  smsBroadcast: { to: "/sms-broadcast", label: "SMS Broadcast", icon: "📣", blurb: "Text a group of clients" },
  whatsappBroadcast: { to: "/whatsapp-broadcast", label: "WhatsApp Broadcast", icon: "🟢", blurb: "Message a group on WhatsApp" },
  analytics: { to: "/analytics", label: "Analytics", icon: "📊", blurb: "Revenue, jobs, clients and leads" },
  jobCosting: { to: "/job-costing", label: "Job Costing", icon: "🧮", blurb: "Profit on each job" },
  inventory: { to: "/inventory", label: "Inventory", icon: "🏷️", blurb: "Stock levels and orders" },
  team: { to: "/team", label: "Team", icon: "👥", blurb: "Staff and technicians" },
  knowledge: { to: "/knowledge", label: "Knowledge", icon: "📚", blurb: "How-tos and procedures" },
  notes: { to: "/notes", label: "Notes", icon: "🗒️", blurb: "Notebooks and daily notes" },
  settings: { to: "/settings", label: "Settings", icon: "⚙️", blurb: "Company, templates and setup" },
} satisfies Record<string, AppModule>;

export const DASHBOARD_TILES: AppModule[] = [
  MODULES.dispatch,
  MODULES.clients,
  MODULES.priceBook,
  MODULES.quotes,
  MODULES.invoices,
  MODULES.analytics,
  MODULES.settings,
];

export const MODULE_GROUPS: { heading: string; modules: AppModule[] }[] = [
  { heading: "Work", modules: [MODULES.jobs, MODULES.dispatch, MODULES.calendar, MODULES.tasks, MODULES.timesheets, MODULES.reports, MODULES.subcontractors] },
  {
    heading: "Clients & sales",
    modules: [MODULES.clients, MODULES.quotes, MODULES.invoices, MODULES.priceBook, MODULES.assets, MODULES.followUps, MODULES.membership, MODULES.googleReviews, MODULES.referrals, MODULES.realEstate],
  },
  { heading: "Messages", modules: [MODULES.channels, MODULES.inbox, MODULES.smsBroadcast, MODULES.whatsappBroadcast] },
  { heading: "Business", modules: [MODULES.analytics, MODULES.jobCosting, MODULES.inventory, MODULES.team, MODULES.knowledge, MODULES.notes, MODULES.settings] },
];
