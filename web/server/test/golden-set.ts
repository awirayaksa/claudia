/**
 * The golden retrieval set: a small company wiki and questions people ask
 * about it, each with the document that answers it. Questions are phrased
 * the way users ask, not copied from the text (different word forms, extra
 * words, partial overlap), and several documents share vocabulary so the
 * ranking has to work for it.
 */
export const GOLDEN_DOCS: Record<string, string> = {
  'vacation-policy.md': `# Vacation policy

Full-time employees receive twenty-five paid vacation days per calendar year. Part-time staff accrue vacation in proportion to their contracted hours.

Unused vacation days can be carried over into the first quarter of the next year, up to a maximum of five days. Requests must be approved by your manager in the HR portal at least two weeks in advance.

Public holidays are not counted as vacation days. If you fall ill during your vacation, report it on the first day and the days are credited back after a doctor's certificate is received. Vacation during the December freeze needs the approval of your department head.`,

  'sick-leave.md': `# Sick leave

If you are ill, tell your manager before 9:00 on the first day of absence. For absences longer than three days a doctor's certificate is required.

Sick days do not reduce your vacation balance. Long-term illness is handled with occupational health.`,

  'expense-reports.md': `# Expense reports

Submit receipts for business travel, meals with customers and conference fees within thirty days. Expenses are reimbursed with the next salary payment.

Alcohol is not reimbursed. Meals are reimbursed up to 60 euros per person; keep the itemised receipt.

Mileage for using your own car is reimbursed at 0.30 euros per kilometre when no train connection is available. Taxi rides are covered late at night or when carrying equipment. Personal items such as clothing, toiletries and minibar purchases are never reimbursed, even on long trips.`,

  'travel-booking.md': `# Booking business travel

Book flights, trains and hotels through the travel portal so the company card is charged directly. Trains are preferred for trips under five hours.

Economy class is the default for flights shorter than six hours. Hotel rooms must be booked at the negotiated corporate rate where available.`,

  'laptop-setup.md': `# Setting up your laptop

New laptops arrive with the operating system installed. Sign in with your company account, then enrol the device in device management from the Settings app.

Enable full-disk encryption before you store any customer data. The IT service desk can reinstall a laptop within one working day.`,

  'password-rules.md': `# Passwords and two-factor authentication

Passwords must be at least fourteen characters long and must not be reused across services. Use the company password manager to generate and store them.

Two-factor authentication with the authenticator app is mandatory for email, the VPN and the HR portal. Lost phones must be reported to the security team immediately.`,

  'vpn-access.md': `# Remote access with the VPN

Connect to the VPN before opening internal tools from home or while travelling. The VPN client is installed from the self-service software catalogue.

If the connection drops repeatedly, switch from Wi-Fi to a wired network and contact the service desk with the error code shown in the client.`,

  'office-access.md': `# Office access and visitors

Your badge opens the main entrance between 6:00 and 22:00 on weekdays. Visitors must be registered at reception and accompanied at all times.

Lost badges are blocked by facilities; a replacement costs 15 euros and is ready the next day.`,

  'parking.md': `# Parking

The garage under the office has 120 spaces, assigned first come, first served. Electric cars can charge at the eight charging stations on level -1.

Bicycles go in the locked shed next to the entrance; showers are on the ground floor.`,

  'onboarding.md': `# Your first week

On your first day, collect your badge and laptop from reception at 9:00. Your buddy will introduce you to the team and show you around.

During the first week you complete the mandatory security training and the data protection course in the learning platform.`,

  'performance-reviews.md': `# Performance reviews

Reviews take place twice a year, in June and December. You and your manager agree on goals and review progress against them.

Salary adjustments are decided after the December review and take effect in January.`,

  'parental-leave.md': `# Parental leave

Parents receive sixteen weeks of fully paid parental leave, which can be split into up to three blocks within the child's first two years.

Tell HR about planned leave at least eight weeks before it starts so your work can be covered.`,

  'code-review.md': `# Code review guidelines

Every pull request needs one approval from a code owner before it can be merged. Keep pull requests small: under 400 changed lines where possible.

Reviewers should respond within one working day. Automated tests and linting must pass before review.`,

  'incident-response.md': `# Incident response

When production is down, page the on-call engineer through the alerting tool and open an incident channel. The incident commander coordinates communication with customers.

Within five working days after the incident, write a blameless postmortem with timeline, root cause and follow-up actions.

Severity one incidents affect all customers and require an update on the status page every thirty minutes. Severity two incidents affect a single feature or a subset of customers and are updated hourly. Follow-up actions from the postmortem are tracked in the engineering backlog with an owner and a due date.`,

  'customer-refunds.md': `# Customer refunds

Customers may return products within thirty days of delivery for a full refund. Refunds are issued to the original payment method within ten business days.

Damaged goods are replaced free of charge; the customer receives a prepaid return label by email.`,

  'shipping-times.md': `# Shipping times

Orders placed before 14:00 ship the same day from our warehouse. Standard delivery takes two to four business days within the country.

Express delivery arrives the next business day for an extra fee. International shipping takes up to ten days and may include customs charges.

Customers receive a tracking link by email as soon as the parcel leaves the warehouse. Parcels that cannot be delivered are held at the nearest pickup point for seven days before they are returned to us. Large furniture is delivered by a freight partner who calls ahead to agree on a delivery window.`,
};

export const GOLDEN_QUERIES: Array<{ q: string; doc: string }> = [
  { q: 'How many days of paid holiday vacation do I get each year?', doc: 'vacation-policy.md' },
  { q: 'Can leftover vacation be carried into next year?', doc: 'vacation-policy.md' },
  { q: 'Do I need a doctor note when I am sick?', doc: 'sick-leave.md' },
  { q: 'who do I tell when I am ill in the morning', doc: 'sick-leave.md' },
  { q: 'deadline for submitting receipts of my expenses', doc: 'expense-reports.md' },
  { q: 'is wine at a customer dinner reimbursed', doc: 'expense-reports.md' },
  { q: 'where should I book the hotel for a business trip', doc: 'travel-booking.md' },
  { q: 'can I fly business class on short flights', doc: 'travel-booking.md' },
  { q: 'how to enrol a new laptop in device management', doc: 'laptop-setup.md' },
  { q: 'disk encryption requirement for laptops', doc: 'laptop-setup.md' },
  { q: 'minimum password length', doc: 'password-rules.md' },
  { q: 'I lost my phone with the authenticator app', doc: 'password-rules.md' },
  { q: 'VPN keeps disconnecting when working from home', doc: 'vpn-access.md' },
  { q: 'my badge got lost, what does a replacement cost', doc: 'office-access.md' },
  { q: 'can visitors walk around the office alone', doc: 'office-access.md' },
  { q: 'where can I charge my electric car', doc: 'parking.md' },
  { q: 'is there bicycle parking and showers', doc: 'parking.md' },
  { q: 'what happens on my first day', doc: 'onboarding.md' },
  { q: 'when are salary raises decided', doc: 'performance-reviews.md' },
  { q: 'how long is paid parental leave for new parents', doc: 'parental-leave.md' },
  { q: 'how many approvals does a pull request need before merging', doc: 'code-review.md' },
  { q: 'production outage, who do I page', doc: 'incident-response.md' },
  { q: 'when is the postmortem due after an incident', doc: 'incident-response.md' },
  { q: 'customer wants their money back for a returned product', doc: 'customer-refunds.md' },
  { q: 'item arrived damaged, will it be replaced', doc: 'customer-refunds.md' },
  { q: 'how fast is express delivery', doc: 'shipping-times.md' },
  { q: 'shipping abroad customs charges', doc: 'shipping-times.md' },
  { q: 'order cut-off time for same day shipping', doc: 'shipping-times.md' },
  { q: 'I got sick while on vacation, do I lose those days?', doc: 'vacation-policy.md' },
  { q: 'mileage rate for driving my own car', doc: 'expense-reports.md' },
  { q: 'how often to update the status page in a severity one incident', doc: 'incident-response.md' },
  { q: 'parcel could not be delivered, where is it held', doc: 'shipping-times.md' },
];

/** recall@k must reach this with hybrid search; keyword-only search has a lower bar. */
export const RECALL_AT = 5;
export const MIN_RECALL_HYBRID = 0.95;
export const MIN_RECALL_KEYWORD = 0.85;
