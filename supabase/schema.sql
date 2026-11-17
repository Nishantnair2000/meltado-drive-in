-- =====================================================================
--  MELTADO DRIVE-IN — DATABASE SETUP
--  Paste this whole file into Supabase > SQL Editor > New query > Run.
--  Safe to run once on a fresh project.
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- Settings (one row). EDIT cafe_lat / cafe_lng below before running,
-- or later in Table Editor > app_settings.
-- ---------------------------------------------------------------------
create table public.app_settings (
  id                          int primary key default 1 check (id = 1),
  cafe_lat                    double precision not null,
  cafe_lng                    double precision not null,
  radius_m                    int  not null default 500,   -- 1 km diameter
  gps_slack_m                 int  not null default 50,    -- tolerance for GPS drift
  require_otp                 boolean not null default false,
  accepting_orders            boolean not null default true,
  max_active_per_phone        int  not null default 3,   -- a car can have several separate orders going at once
  max_orders_per_phone_per_2h int  not null default 6
);
insert into public.app_settings (cafe_lat, cafe_lng)
values (28.6542, 77.3025);   -- Meltado (approximate) — replace with the exact entrance pin before launch

-- ---------------------------------------------------------------------
-- Staff: only users listed here can see and update orders.
-- ---------------------------------------------------------------------
create table public.staff (
  user_id uuid primary key references auth.users(id) on delete cascade,
  name    text
);

-- ---------------------------------------------------------------------
-- Orders
-- ---------------------------------------------------------------------
create type public.order_status as enum ('new', 'entered_pos', 'out_for_delivery', 'delivered', 'cancelled');

create table public.orders (
  id              uuid primary key default gen_random_uuid(),
  order_no        int generated always as identity (start with 101),
  status          public.order_status not null default 'new',
  status_token    uuid not null default gen_random_uuid(),   -- lets the customer page read its own status
  customer_name   text not null check (char_length(customer_name) between 2 and 60),
  phone           text not null check (phone ~ '^[6-9][0-9]{9}$'),
  car_last4       text not null check (car_last4 ~ '^[A-Z0-9]{4}$'),
  car_model       text check (char_length(car_model) <= 60),          -- optional
  car_colour      text check (char_length(car_colour) <= 30),         -- optional
  landmark        text check (char_length(landmark) <= 140),
  notes           text check (char_length(notes) <= 280),
  lat             double precision not null,
  lng             double precision not null,
  accuracy_m      double precision,
  distance_m      double precision not null,
  items           jsonb not null,
  est_total       int not null check (est_total between 0 and 100000),
  device_id       text,
  phone_verified  boolean not null default false,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  received_at     timestamptz                 -- set when the CUSTOMER confirms receipt
);
create index orders_created_idx on public.orders (created_at desc);
create index orders_phone_idx   on public.orders (phone, created_at desc);
create index orders_device_idx  on public.orders (device_id) where status in ('new','entered_pos','out_for_delivery');

create or replace function public.touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;
create trigger orders_touch before update on public.orders
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------
create or replace function public.haversine_m(lat1 float8, lng1 float8, lat2 float8, lng2 float8)
returns float8 language sql immutable as $$
  select 2 * 6371000 * asin(sqrt(
    power(sin(radians(lat2 - lat1) / 2), 2) +
    cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lng2 - lng1) / 2), 2)
  ));
$$;

create or replace function public.is_staff() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.staff where user_id = auth.uid());
$$;

-- What the customer page needs before ordering (no private data).
create or replace function public.get_public_settings() returns json
language sql stable security definer set search_path = public as $$
  select json_build_object(
    'cafe_lat', cafe_lat, 'cafe_lng', cafe_lng, 'radius_m', radius_m,
    'gps_slack_m', gps_slack_m, 'require_otp', require_otp, 'accepting_orders', accepting_orders)
  from public.app_settings where id = 1;
$$;

create or replace function public.is_active_order(p_status public.order_status, p_updated timestamptz)
returns boolean language sql stable as $$
  select p_status in ('new', 'entered_pos')
      or (p_status = 'out_for_delivery' and p_updated > now() - interval '45 minutes');
$$;

-- ---------------------------------------------------------------------
-- place_order: the ONLY way customers can create an order.
-- Re-checks the 500 m geofence on the server and applies anti-spam rules.
-- ---------------------------------------------------------------------
create or replace function public.place_order(
  p_name text, p_phone text, p_car_last4 text, p_car_model text, p_car_colour text,
  p_landmark text, p_notes text, p_lat float8, p_lng float8, p_accuracy float8,
  p_items jsonb, p_est_total int, p_device_id text
) returns json
language plpgsql security definer set search_path = public as $$
declare
  s        public.app_settings;
  v_phone  text;
  v_dist   float8;
  v_verified boolean := false;
  r        public.orders;
begin
  select * into s from public.app_settings where id = 1;
  if not s.accepting_orders then raise exception 'CLOSED'; end if;

  v_phone := regexp_replace(coalesce(p_phone, ''), '\D', '', 'g');
  if length(v_phone) = 12 and left(v_phone, 2) = '91' then v_phone := right(v_phone, 10); end if;
  if v_phone !~ '^[6-9][0-9]{9}$' then raise exception 'BAD_DETAILS'; end if;

  -- Optional SMS OTP: the caller must be signed in with this exact phone number.
  if s.require_otp then
    if auth.uid() is null
       or right(regexp_replace(coalesce(auth.jwt() ->> 'phone', ''), '\D', '', 'g'), 10) <> v_phone then
      raise exception 'OTP_REQUIRED';
    end if;
    v_verified := true;
  end if;

  -- Geofence
  if p_lat is null or p_lng is null or p_lat not between -90 and 90 or p_lng not between -180 and 180 then
    raise exception 'NO_LOCATION';
  end if;
  v_dist := public.haversine_m(s.cafe_lat, s.cafe_lng, p_lat, p_lng);
  if v_dist > s.radius_m + s.gps_slack_m then raise exception 'OUT_OF_RANGE'; end if;

  -- Items sanity
  if p_items is null or jsonb_typeof(p_items) <> 'array' then raise exception 'BAD_ITEMS'; end if;
  if jsonb_array_length(p_items) not between 1 and 40 then raise exception 'BAD_ITEMS'; end if;
  if exists (
    select 1 from jsonb_array_elements(p_items) e
    where jsonb_typeof(e) <> 'object'
       or coalesce(e ->> 'name', '') = ''
       or case when coalesce(e ->> 'qty', '') ~ '^[0-9]{1,2}$'
               then (e ->> 'qty')::int not between 1 and 20
               else true end
  ) then raise exception 'BAD_ITEMS'; end if;

  -- Anti-spam (lock per phone so two taps can't slip through together)
  perform pg_advisory_xact_lock(hashtext(v_phone));
  -- "Out for delivery" stops counting as active after 45 min, in case a customer
  -- drives off without tapping "I've received my order".
  if (select count(*) from public.orders o
      where o.phone = v_phone and public.is_active_order(o.status, o.updated_at)) >= s.max_active_per_phone
     or (p_device_id is not null and (select count(*) from public.orders o
      where o.device_id = p_device_id and public.is_active_order(o.status, o.updated_at)) >= s.max_active_per_phone) then
    raise exception 'ACTIVE_ORDER_EXISTS';
  end if;
  if (select count(*) from public.orders o
      where o.phone = v_phone and o.created_at > now() - interval '2 hours') >= s.max_orders_per_phone_per_2h then
    raise exception 'RATE_LIMIT';
  end if;

  insert into public.orders (customer_name, phone, car_last4, car_model, car_colour, landmark, notes,
                             lat, lng, accuracy_m, distance_m, items, est_total, device_id, phone_verified)
  values (trim(p_name), v_phone, upper(trim(p_car_last4)), nullif(trim(p_car_model), ''), nullif(trim(p_car_colour), ''),
          nullif(trim(p_landmark), ''), nullif(trim(p_notes), ''),
          p_lat, p_lng, p_accuracy, round(v_dist::numeric, 1), p_items, greatest(0, coalesce(p_est_total, 0)),
          left(p_device_id, 64), v_verified)
  returning * into r;

  return json_build_object('order_id', r.id, 'order_no', r.order_no, 'status_token', r.status_token);
exception
  when check_violation or not_null_violation then raise exception 'BAD_DETAILS';
end $$;

-- Customer reads only their own order status (needs the secret token from place_order).
create or replace function public.get_order_status(p_order_id uuid, p_token uuid) returns json
language sql stable security definer set search_path = public as $$
  select json_build_object('status', status, 'order_no', order_no, 'updated_at', updated_at)
  from public.orders where id = p_order_id and status_token = p_token;
$$;

-- Customer confirms they received the order (only possible once it is out for delivery).
-- This is the ONLY way an order becomes 'delivered'.
create or replace function public.confirm_received(p_order_id uuid, p_token uuid) returns json
language plpgsql security definer set search_path = public as $$
declare r public.orders;
begin
  update public.orders set status = 'delivered', received_at = now()
   where id = p_order_id and status_token = p_token and status = 'out_for_delivery'
  returning * into r;
  if r.id is null then
    if exists (select 1 from public.orders where id = p_order_id and status_token = p_token and status = 'delivered') then
      return json_build_object('status', 'delivered');           -- already confirmed (double tap)
    end if;
    raise exception 'NOT_OUT_FOR_DELIVERY';
  end if;
  return json_build_object('status', r.status, 'received_at', r.received_at);
end $$;

-- ---------------------------------------------------------------------
-- Security (Row Level Security)
-- ---------------------------------------------------------------------
alter table public.orders       enable row level security;
alter table public.staff        enable row level security;
alter table public.app_settings enable row level security;

-- Nobody writes orders directly; customers go through place_order().
revoke all on public.orders from anon, authenticated;
grant select on public.orders to authenticated;
grant update (status) on public.orders to authenticated;   -- staff can only change the status
create policy "staff read orders"   on public.orders for select to authenticated using (public.is_staff());
-- Staff can move orders New -> Entered in POS -> Out for delivery (or cancel),
-- but can never mark 'delivered' or touch an order the customer has confirmed.
create policy "staff update orders" on public.orders for update to authenticated
  using (public.is_staff() and status <> 'delivered')
  with check (public.is_staff() and status <> 'delivered');

revoke all on public.staff from anon, authenticated;
grant select on public.staff to authenticated;
create policy "staff see self" on public.staff for select to authenticated using (user_id = auth.uid());

revoke all on public.app_settings from anon, authenticated;
grant select on public.app_settings to authenticated;
grant update (accepting_orders) on public.app_settings to authenticated;
create policy "staff read settings"   on public.app_settings for select to authenticated using (public.is_staff());
create policy "staff pause orders"    on public.app_settings for update to authenticated using (public.is_staff()) with check (public.is_staff());

revoke all on function public.place_order(text,text,text,text,text,text,text,float8,float8,float8,jsonb,int,text) from public;
grant execute on function public.place_order(text,text,text,text,text,text,text,float8,float8,float8,jsonb,int,text) to anon, authenticated;
grant execute on function public.get_order_status(uuid, uuid) to anon, authenticated;
grant execute on function public.confirm_received(uuid, uuid) to anon, authenticated;
grant execute on function public.get_public_settings() to anon, authenticated;
grant execute on function public.is_staff() to authenticated;

-- ---------------------------------------------------------------------
-- Realtime: push order changes to the counter dashboard instantly.
-- ---------------------------------------------------------------------
alter publication supabase_realtime add table public.orders;
alter publication supabase_realtime add table public.app_settings;

-- =====================================================================
--  AFTER RUNNING: add your counter staff login (see README Step 2):
--    1. Authentication > Users > Add user > email + password
--    2. Run (replace the email):
--       insert into public.staff (user_id, name)
--       select id, 'Counter' from auth.users where email = 'counter@meltado.in';
-- =====================================================================
