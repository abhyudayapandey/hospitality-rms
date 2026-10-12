# ADR 136: Meals by room start at two, a floor in one tap

Status: accepted

Most rooms have two guests, so a room tapped for a meal (ADR 121) starts at 2, and − / + set
the rest. Each floor's heading in the room picker takes all its rooms not yet taken, at 2 each,
as Give rooms does (ADR 132); tapped again, it clears the floor. Nothing is saved until Save,
as before.
