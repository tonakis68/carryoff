-- Stage 2 (payments). Run once in Supabase SQL Editor. Safe to run again.
alter table partners add column if not exists lat double precision;
alter table partners add column if not exists lng double precision;

insert into partners (id, name, email) values
  ('mosaic', 'Kafe Mosaic', 'mosaic@partner.invalid'),
  ('aurora', 'Hotel Aurora front desk', 'aurora@partner.invalid'),
  ('paper', 'Paper & Ink Bookshop', 'paper@partner.invalid'),
  ('kiosk', 'Station Kiosk Plus', 'kiosk@partner.invalid'),
  ('dive', 'Harbour Dive Shop', 'dive@partner.invalid'),
  ('green', 'Greenhouse Coworking', 'green@partner.invalid'),
  ('gift', 'Seaside Gift Gallery', 'gift@partner.invalid'),
  ('bike', 'Bike & Beans', 'bike@partner.invalid'),
  ('corner', 'Corner Store 24', 'corner@partner.invalid'),
  ('hostel', 'Rail Quarter Hostel', 'hostel@partner.invalid')
on conflict (id) do nothing;

update partners set address='Sample address, city centre', lat=43.20536, lng=27.90940 where id='mosaic';
update partners set address='Sample address, near the Sea Garden', lat=43.20643, lng=27.91945 where id='aurora';
update partners set address='Sample address, city centre', lat=43.20250, lng=27.90475 where id='paper';
update partners set address='Sample address, by the railway station', lat=43.19982, lng=27.91087 where id='kiosk';
update partners set address='Sample address, port area', lat=43.19964, lng=27.91920 where id='dive';
update partners set address='Sample address, west of the centre', lat=43.20589, lng=27.89887 where id='green';
update partners set address='Sample address, Sea Garden entrance', lat=43.20893, lng=27.92337 where id='gift';
update partners set address='Sample address, near the bus station', lat=43.21304, lng=27.90132 where id='bike';
update partners set address='Sample address, near the bus station', lat=43.21375, lng=27.89372 where id='corner';
update partners set address='Sample address, by the railway station', lat=43.19589, lng=27.91639 where id='hostel';

-- Index for the hourly unpaid-booking limit.
create index if not exists bookings_email_day on bookings (customer_email, created_at desc);
