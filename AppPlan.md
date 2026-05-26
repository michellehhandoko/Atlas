



If the app requires interactive front-end behavior or machine learning models, use React or FastAPI as necessary. If the app uses an LLM or RAG, make the system prompt explicit in the code instead of burying it inside a long request string.


Use case: Between figuring out transportation, lodging, activities, and food, planning the perfect trip is time-intensive, especially with the breadth/availability of resources out there today. Throw in seasonality, weather conditions, and budgetary constraints, and the task becomes even more unwieldy. With [TRAVEL AGENT NAME], travelers can create and edit their personalized itinerary in minutes. 

- Intended user: Busy professionals, individuals, adults, friend groups or families, who want to make the most of their limited PTO and travel the world but do not have the time to create a great itinerary themselves. They have opinions on key things they want to see, do, or eat during their trip, but may need help filling in the rest. They have varying travel styles (go with the flow vs. strict Type A), but generally value some sort of structure or plan as a foundation or a few suggestions to explore and take into consideration. 

[What will the user type, upload, or choose?]
- User input: User should upload the destination, the duration and dates they will be there, ideas of what they want to do, how strict of an itinerary they want (flexible, by the hour, top 3 things to prioritize), budget range, any travel loyalty programs they belong to, size of their travel group  

[What should the model return?]
- Model output: model returns a detailed daily itinerary with options and pictures, hotel and transportation options, links to bookings and reservations, restaurant and food options, prices, save all the itinerary locations to a google maps list that can be added to the travelers google maps   
Can include webpage layout with links and photos and more, while also including a smaller itinerary summary layout, and create option to download ics file or sync into a calendar / shareable

[If this is an LLM or RAG app, what role should the model play, what rules should it follow, and what format should it return? If this is not an LLM app, write not applicable.]
- System prompt requirements: you are a friendly travel agent helping optimize a plan for the users next vacation 

Claude:
Role
The model plays the role of a personal travel concierge expert, efficient, and opinionated. It should feel like texting a friend who has traveled everywhere and happens to know your budget. Not a generic chatbot, not a search engine it makes specific recommendations and justifies them briefly.

Rules to Follow
Always respect the user's stated budget and never suggest options that exceed it
Never recommend a generic tourist trap without acknowledging it ("yes it's touristy but worth it because...")
If the destination or dates are vague, ask one clarifying question before generating the itinerary
Always account for travel time between stops don't schedule back-to-back activities on opposite sides of a city
Adjust recommendations based on weather data passed in (don't suggest outdoor hiking if it's forecasted to rain)
Never hallucinate specific prices use ranges instead ("budget ~$15-20 for lunch here")
Keep tone friendly and confident, not robotic

Output Format
Return a structured JSON object so your frontend can render it cleanly: Returning plain prose would mean parsing text on the frontend to build the map and budget display — messy and brittle. Structured JSON means each piece of your UI (map, budget breakdown, day-by-day cards) just reads its own field. Much cleaner for a demo that needs to not break on June 1st.
Need to adjust this for what output we want
[Approach]
tech stack would look like:
LLM API (Claude or Gemini Flash as the brief suggests) — generates the itinerary
Google Maps API — renders the route visually
Weather API (OpenWeatherMap is free) — informs day-by-day planning
Budget logic — honestly just prompt engineering, telling the LLM to allocate across categories

- Important source material or dataset: None

- App name: [Atlas]

- Tone and style: Playful and concise, fun and exciting. Should have the tone of like a tour guide. Educational, but not too boring. 

- Colors: playful and colorful; shades of blue; calming [Any preferred colors, brand colors, or colors to avoid]

- Fonts: Serif, editorial font; reminiscent of a lifestyle/travel magazine

- Layout: [Single page, sidebar, form plus results panel, chat-style, dashboard, etc.]
webpage layout with links and photos and more, while also including a smaller itinerary summary layout, and create option to download ics file or sync into a calendar / shareable

- Visual tone: warm fun, professional, clean

