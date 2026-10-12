# ADR 131: "Departing", not "Leaving"

Status: accepted

A room whose guest checks out today reads **Departing** again (status code `DEP`), on its tile,
its filter chip, its time ("Departing at") and in the database (`ops.room_status_name`). ADR 117
had made it "Leaving" for plain words, but in a hotel "leaving" can mean a guest going out for
lunch or a meeting; "Departing" is the front office's word for checking out. Plain language
(ADR 129) yields to the trade's own words where the plain one is ambiguous.
