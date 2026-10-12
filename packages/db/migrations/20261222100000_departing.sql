-- migrate:up
-- A room checking out today is "Departing", the word front offices use (ADR 131). "Leaving"
-- could mean a guest out for lunch.
create or replace function ops.room_status_name(p_status text) returns text
language sql immutable
as $$
  select case p_status
           when 'VC' then 'Vacant clean' when 'VD' then 'Vacant dirty'
           when 'OCC' then 'Occupied' when 'ARR' then 'Arriving'
           when 'DEP' then 'Departing' when 'OOO' then 'Out of order' end;
$$;

-- migrate:down
create or replace function ops.room_status_name(p_status text) returns text
language sql immutable
as $$
  select case p_status
           when 'VC' then 'Vacant clean' when 'VD' then 'Vacant dirty'
           when 'OCC' then 'Occupied' when 'ARR' then 'Arriving'
           when 'DEP' then 'Leaving' when 'OOO' then 'Out of order' end;
$$;
