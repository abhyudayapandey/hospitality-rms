// The one-time welcome card on Home (UX-12): three short lines for the person's role,
// then it is gone for good on that phone. Words only, no links.

import type { NavProfile } from './nav';

export const FIRST_RUN: Readonly<Record<NavProfile, readonly string[]>> = {
  frontline: [
    'Your shift and your next job are at the top.',
    'Tap Start to do the job; Clock in appears when your shift is near.',
    'Everything else is under Me.',
  ],
  store: [
    'The big buttons are your day: to order, receive, send, running low, count.',
    'Search an item in Stock to see what is left.',
    'Everything else is under Me.',
  ],
  department: [
    '"Do these first" is what needs you now; "Waiting for you" needs your yes.',
    "Today's figures for your department follow.",
    'Roster, Stock and Reports are in the bar at the bottom.',
  ],
  outlet: [
    '"Do these first" is what needs you now, most urgent first.',
    '"Waiting for you" needs your yes: approve or say no right there.',
    "Today's figures follow; every department is one tap away.",
  ],
  cost: [
    'Stock and Reports are in the bar at the bottom.',
    '"Do these first" is what needs you now.',
    'Each report opens with its key figures; "More figures" has the rest.',
  ],
  office: [
    '"Waiting for you" needs your yes.',
    'Reports open with their key figures; "More figures" has the rest.',
    'Everything else is in the bar at the bottom and under Me.',
  ],
};

export const firstRunKey = (profile: NavProfile) => `outlet-ops:welcome:${profile}`;
