# books

**Page:** https://books.toscrape.com/

**Prompt:** Find the cheapest book in the Travel category on this site. Tell me its title and price.

**Model:** `auto` through a local server · end_turn · 20 s · 4 tool calls

**What it did:**

- `read_page` {"filter":"interactive"}
- `computer` {"ref":"ref_4","action":"left_click"}
- `extract_list` {"action":"detect"}
- `extract_list` {"action":"extract","fields":{"price":"p.price_color","title":"h3 > a@title"},"list":"list1"}

**Its answer:**

> The cheapest book in the Travel category is **"The Road to Little Dribbling: Adventures of an American in Britain (Notes From a Small Island #2)"** with a price of **£23.21**.
