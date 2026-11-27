-- Stage 4: real partners. Run once in the Supabase SQL editor. Safe to run again.
alter table partners add column if not exists type text;
alter table partners add column if not exists descr text;
alter table partners add column if not exists perks text[] not null default '{}';
alter table partners add column if not exists cap int not null default 20;            -- bags the place can hold at once
alter table partners add column if not exists hours jsonb;                           -- 7 entries, Sunday first: ["08:00","20:00"] or null when closed
alter table partners add column if not exists pub_lat double precision;              -- approximate pin shown before payment
alter table partners add column if not exists pub_lng double precision;
alter table partners add column if not exists contact text;
alter table partners add column if not exists area text;                              -- rough area shown to customers before payment, e.g. 'near the Sea Garden'
create index if not exists bookings_partner_status on bookings (partner_id, status, drop_date);

-- The ten sample places keep working: same hours, capacity and approximate pins as before.
update partners set type='Café', descr='Counter staff keep bags in a locked back room. Look for the CarryOff sticker on the door.', perks=array['Locked back room','Staff on site']::text[], cap=30, hours='[["08:00","20:00"],["08:00","20:00"],["08:00","20:00"],["08:00","20:00"],["08:00","20:00"],["08:00","20:00"],["08:00","20:00"]]'::jsonb where id='mosaic';
update partners set type='Hotel', descr='Open around the clock, so late arrivals and early departures are covered.', perks=array['Open 24 hours','CCTV in storage room']::text[], cap=60, hours='[["00:00","24:00"],["00:00","24:00"],["00:00","24:00"],["00:00","24:00"],["00:00","24:00"],["00:00","24:00"],["00:00","24:00"]]'::jsonb where id='aurora';
update partners set type='Shop', descr='A quiet bookshop with a small storage room behind the till. Closed on Sundays.', perks=array['Staff on site']::text[], cap=18, hours='[null,["10:00","19:00"],["10:00","19:00"],["10:00","19:00"],["10:00","19:00"],["10:00","19:00"],["10:00","19:00"]]'::jsonb where id='paper';
update partners set type='Kiosk', descr='A few steps from the platforms. Best for short stops between trains.', perks=array['Next to the station','Early and late hours']::text[], cap=40, hours='[["06:00","23:00"],["06:00","23:00"],["06:00","23:00"],["06:00","23:00"],["06:00","23:00"],["06:00","23:00"],["06:00","23:00"]]'::jsonb where id='kiosk';
update partners set type='Activity shop', descr='Storage racks beside the dive lockers, close to the port.', perks=array['Staff on site']::text[], cap=24, hours='[["09:00","16:00"],["09:00","18:00"],["09:00","18:00"],["09:00","18:00"],["09:00","18:00"],["09:00","18:00"],["09:00","18:00"]]'::jsonb where id='dive';
update partners set type='Coworking', descr='Lockers in the entrance hall, watched by the front desk. Closed on Sundays.', perks=array['Lockers','CCTV']::text[], cap=50, hours='[null,["08:00","21:00"],["08:00","21:00"],["08:00","21:00"],["08:00","21:00"],["08:00","21:00"],["10:00","16:00"]]'::jsonb where id='green';
update partners set type='Shop', descr='Small shop by the park entrance. Fills up fast on weekends.', perks=array['Staff on site']::text[], cap=20, hours='[["11:00","20:00"],["10:00","21:00"],["10:00","21:00"],["10:00","21:00"],["10:00","21:00"],["10:00","21:00"],["10:00","21:00"]]'::jsonb where id='gift';
update partners set type='Café', descr='Café and bike repair stand. Bags go in the workshop behind the counter.', perks=array['Staff on site']::text[], cap=22, hours='[["08:30","18:00"],["07:30","19:30"],["07:30","19:30"],["07:30","19:30"],["07:30","19:30"],["07:30","19:30"],["08:00","19:30"]]'::jsonb where id='bike';
update partners set type='Convenience store', descr='Long hours and a back storeroom, a short walk from the bus station.', perks=array['Long hours','Staff on site']::text[], cap=36, hours='[["06:00","23:00"],["06:00","23:00"],["06:00","23:00"],["06:00","23:00"],["06:00","23:00"],["06:00","23:00"],["06:00","23:00"]]'::jsonb where id='corner';
update partners set type='Hostel', descr='Luggage room behind reception, close to the station and the port.', perks=array['Luggage room','Staff on site']::text[], cap=45, hours='[["07:00","23:00"],["07:00","23:00"],["07:00","23:00"],["07:00","23:00"],["07:00","23:00"],["07:00","23:00"],["07:00","23:00"]]'::jsonb where id='hostel';
update partners set pub_lat=43.20536, pub_lng=27.90940 where id='mosaic';
update partners set pub_lat=43.20643, pub_lng=27.91945 where id='aurora';
update partners set pub_lat=43.20250, pub_lng=27.90475 where id='paper';
update partners set pub_lat=43.19982, pub_lng=27.91087 where id='kiosk';
update partners set pub_lat=43.19964, pub_lng=27.91920 where id='dive';
update partners set pub_lat=43.20589, pub_lng=27.89887 where id='green';
update partners set pub_lat=43.20893, pub_lng=27.92337 where id='gift';
update partners set pub_lat=43.21304, pub_lng=27.90132 where id='bike';
update partners set pub_lat=43.21375, pub_lng=27.89372 where id='corner';
update partners set pub_lat=43.19589, pub_lng=27.91639 where id='hostel';

update partners set area='city centre' where id='mosaic';
update partners set area='near the Sea Garden' where id='aurora';
update partners set area='city centre' where id='paper';
update partners set area='by the railway station' where id='kiosk';
update partners set area='port area' where id='dive';
update partners set area='west of the centre' where id='green';
update partners set area='Sea Garden entrance' where id='gift';
update partners set area='near the bus station' where id='bike';
update partners set area='near the bus station' where id='corner';
update partners set area='by the railway station' where id='hostel';
