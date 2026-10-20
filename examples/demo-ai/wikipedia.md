# wikipedia

**Page:** https://en.wikipedia.org/wiki/Main_Page

**Prompt:** Use Wikipedia to find out who created the first web browser and in which year. Answer in one sentence.

**Model:** `auto` through a local server · end_turn · 52 s · 10 tool calls

**What it did:**

- `navigate` {"url":"https://en.wikipedia.org/wiki/Main_Page"}
- `find` {"query":"first web browser"}
- `form_input` {"value":"first web browser","ref":"ref_4"}
- `read_page` {"filter":"interactive"}
- `form_input` {"value":"first web browser","ref":"ref_3"}
- `computer` {"ref":"ref_4","action":"left_click"}
- `get_page_text` {}
- `find` {"query":"WorldWideWeb"}
- `navigate` {"url":"https://en.wikipedia.org/wiki/WorldWideWeb"}
- `get_page_text` {"max_chars":3000}

**Its answer:**

> The first web browser, WorldWideWeb (later renamed Nexus), was created by Tim Berners-Lee in 1990.
