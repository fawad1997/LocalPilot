# form

**Page:** https://httpbin.org/forms/post

**Prompt:** Fill this pizza order form for Jane Doe (phone +31 20 123 4567, email jane@example.com): a large pizza with mushroom and onion, delivery instructions "Ring the bell twice". Do NOT submit the form. Tell me when it is filled.

**Model:** `auto` through a local server · end_turn · 21 s · 8 tool calls

**What it did:**

- `read_page` {"filter":"interactive"}
- `form_input` {"ref":"ref_1","value":"Jane Doe"}
- `form_input` {"ref":"ref_2","value":"+31 20 123 4567"}
- `form_input` {"ref":"ref_3","value":"jane@example.com"}
- `form_input` {"ref":"ref_6","value":true}
- `form_input` {"ref":"ref_9","value":true}
- `form_input` {"ref":"ref_10","value":true}
- `form_input` {"ref":"ref_12","value":"Ring the bell twice"}

**Its answer:**

> The pizza order form is now filled in:
> 
> - **Customer name:** Jane Doe
> - **Telephone:** +31 20 123 4567
> - **E-mail address:** jane@example.com
> - **Size:** Large
> - **Toppings:** Mushroom and Onion
> - **Delivery instructions:** Ring the bell twice
> 
> I have **not** submitted the form, as requested. You can review it and submit it yourself.
