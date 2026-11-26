-- Sample partners so the login can be tested. Run AFTER schema.sql.
-- The emails below are placeholders that cannot receive mail (.invalid).
-- Change ONE of them to your own email to test the partner login, for example:
--   update partners set email = 'you@gmail.com' where id = 'mosaic';
-- (emails must be lowercase)

insert into partners (id, name, email) values
  ('mosaic',  'Kafe Mosaic',            'mosaic@partner.invalid'),
  ('aurora',  'Hotel Aurora front desk','aurora@partner.invalid'),
  ('paper',   'Paper & Ink Bookshop',   'paper@partner.invalid'),
  ('kiosk',   'Station Kiosk Plus',     'kiosk@partner.invalid'),
  ('dive',    'Harbour Dive Shop',      'dive@partner.invalid'),
  ('green',   'Greenhouse Coworking',   'green@partner.invalid')
on conflict (id) do nothing;
