# Atlas Demo Pitch Script

## Goal

Record a short product walkthrough that answers:

1. What is the problem?
2. What did you build and how does it work?
3. Who are the end users, and how does the app deliver value?
4. What are the main limitations?
5. How would you improve the product?

## Suggested Demo Setup

Use a clean browser window. Start at the Atlas home page.

Recommended demo trip:

- Destination: `Los Angeles`
- Departure: choose a near future date
- Return: choose 2-3 days later
- Travelers: `Couple (2)`
- Budget: `Mid-range`
- Trip style: `Structured`
- Interests: `food, architecture, scenic views, local neighborhoods`

Optional second quick demo:

- Trip style: `Top 3`
- Destination: `Tokyo`
- Show that Top 3 creates a shortlist instead of a full day-by-day schedule.

## Demo Script With Actions

### 1. Opening: The Problem

**Action:** Show the Atlas home page.

**Say:**

"Atlas is an AI-powered travel concierge. The problem I focused on is that planning a trip is fragmented and time-consuming. A traveler usually has to search across maps, blogs, restaurant sites, hotel sites, calendar tools, and notes apps just to build one usable plan. It is not just about finding recommendations. The hard part is turning those recommendations into an itinerary that fits the dates, budget, location, timing, and actual things the traveler still needs to book."

### 2. What I Built

**Action:** Point to the form fields.

**Say:**

"I built Atlas as a full web app that takes the key trip inputs: destination, departure and return dates, group size, budget, trip style, interests, and optional loyalty programs. It supports both single-destination and multi-city trips."

**Action:** Fill in the demo trip fields.

**Say:**

"Before generating the itinerary, Atlas validates the destination using Google Places. This helps prevent a common AI failure mode: planning for the wrong location when two cities or places have the same name."

### 3. Generate The Itinerary

**Action:** Click the submit button and show the loading screen.

**Say:**

"When I submit, Atlas makes AI calls through the backend. The app splits the work into a core itinerary call and a supporting details call. That lets the day-by-day itinerary appear faster while details like hotel, transport, budget, and checklist load in parallel."

### 4. Show Results Overview

**Action:** When results load, show the trip banner and trip overview card.

**Say:**

"The result is not just a paragraph of travel advice. Atlas creates a structured trip page with the trip summary, dates, pace, stops, highlights, and checklist count."

### 5. Show Map And Verification

**Action:** Scroll to the map.

**Say:**

"The itinerary is map-aware. Atlas uses Google Maps and Google Places to enrich the generated activities after the itinerary loads. When it can verify a place, it adds details like a Google Maps link, rating, address, coordinates, and sometimes a real place photo. If a match looks unreliable or too far from the expected destination, Atlas avoids showing a wrong pin."

**Action:** Click or hover around the map/pins if available.

**Say:**

"That matters because a travel app has to earn trust. It is better to show fewer verified pins than to confidently show a wrong location."

### 6. Show Day Cards

**Action:** Scroll to the itinerary day card.

**Say:**

"Each day includes timed activities, descriptions, price ranges, travel notes, and links. Atlas tips are intentionally limited so they feel useful rather than repetitive."

### 7. Show Editing

**Action:** Click `Swap` on one activity. Enter a short hint like `make this more casual` or `cheaper`.

**Say:**

"The user can edit the trip without starting over. The Swap feature replaces one activity while preserving the time and category, so the itinerary stays structured."

**Action:** Optionally click `Regenerate day`.

**Say:**

"For bigger changes, the user can regenerate a day. Atlas keeps the date and destination locked, then gives fresh recommendations."

### 8. Show Trip Logistics

**Action:** Scroll below the itinerary to Trip Logistics.

**Say:**

"Below the itinerary, Atlas organizes the practical planning details into Trip Logistics: where to stay, how to get around, and budget breakdown. This turns the output into something closer to a travel workspace, not just an AI response."

### 9. Show Checklist

**Action:** Scroll to Before You Go.

**Say:**

"The Before You Go checklist translates the plan into action. It includes booking tasks, transportation tasks, restaurant or activity reservations, and document reminders when relevant. Each item has priority and timing context."

### 10. Show Save, Share, Calendar, Print

**Action:** Show top nav buttons.

**Say:**

"Atlas also supports real product workflows: saved trips, share links, calendar export, and print. The trip is saved to a database and can be reopened from My Trips or shared with someone else."

**Action:** Click `Print`, show the Print Pack modal.

**Say:**

"Print Pack lets the user print all days, a selected day, or a day range. The print layout is designed to look like a cleaner travel document rather than a raw website printout."

**Action:** Close print dialog.

### 11. Optional Top 3 Demo

**Action:** Start a new trip or mention without demoing.

**Say:**

"Atlas also has a Top 3 mode for users who do not want a full schedule. It creates a trip-wide shortlist of exactly three must-see picks, with special map behavior and no route connector lines."

### 12. End Users And Value

**Action:** Return to the results page overview.

**Say:**

"The end users are busy travelers, couples, friend groups, families, or professionals with limited time to plan. Atlas delivers value by reducing research time, organizing decisions, validating locations, and turning a trip idea into a usable plan with maps, tasks, links, print, calendar, and sharing."

### 13. Limitations

**Say:**

"The main limitations are that AI-generated recommendations can still be imperfect, especially for niche destinations or changing real-world availability. Google Places enrichment reduces some risk, but not every activity can be verified. The app is also not a booking engine, so the user still has to reserve hotels, restaurants, flights, and tickets themselves. Finally, the broad full-itinerary revision feature was hidden because targeted edits like Swap and Regenerate are more reliable."

### 14. Improvements

**Say:**

"If I continued building Atlas, I would improve mobile polish, add stronger error monitoring, make checklist tasks more day-specific, support manual inline edits like changing times or deleting activities, and eventually add accounts or saved preferences. I would also keep improving trust signals around verified places and availability."

### 15. Closing

**Say:**

"Overall, Atlas turns travel planning from a scattered research process into one organized, editable, shareable itinerary workspace."

