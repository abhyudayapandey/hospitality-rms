# 144. One word: Request

Date: 2026-10-14. Status: accepted. Migration `20261229100000_one_word_request`.

## Context

The app used several names for getting things: an Ask (staff to their head), a Stock request
(from a store), a Request for material (a department from its own store) and a Supply request
(to buy). The owner found it confusing; a frontline person with little schooling would too.
Where it comes from is the app's business, not a name the person has to learn.

## Decision

1. **Request** is the one word for what people ask for, whoever asks and wherever it comes
   from. The RFMs tile keeps its name, an industry term; its tabs are Request · Transfer ·
   History.
2. **Two forms stay**, named for what they do: **Request from a store** (stock already in the
   building) and **Request to buy** (from a supplier). The owner chose this over one form that
   routes each line, so the person still picks one.
3. **Order** stays for what the Main Store buys from a supplier, for those who handle money.
4. **Steps keep their action words**: Send, Receive, Collect, Approve say what to do.
5. **Titles of new tasks and alerts**: "Request from Sana Shaikh: 30 × Soda", "Request from the
   Kitchen Store: 5 × Masala", "To approve: request from the Kitchen Store to the Main Store:
   …", "To approve: request from the Kitchen Store to buy …", "Your request was ordered", "Your
   request arrived". Open asks waiting on a head are renamed by the migration; past alerts keep
   their words.
6. **A guard test** (`lib/one-word.test.ts`) fails if "Stock request", "Supply request",
   "Request for material" or "Ask for stock / supplies / these / more" come back in the web
   app's code.

## Consequences

The data model does not change: `inv.staff_ask`, `inv.transfer` (kinds `rfm`, `request`,
`send`) and `inv.purchase_order` stay as they are, with their code names. Leave keeps "Ask for
leave": it is not materials.
