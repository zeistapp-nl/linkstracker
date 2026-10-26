INSERT INTO apps (slug, naam, redirect_domein, fallback_url, utm_source, rewrite_modus) VALUES
  ('zeist', 'ZeistApp', 'go.zeistapp.nl', 'https://www.zeistapp.nl/', 'zeistapp', 'dry_run'),
  ('gooisemeren', 'GooiseMerenApp', 'go.gooisemerenapp.nl', 'https://www.gooisemerenapp.nl/', 'gooisemerenapp', 'dry_run')
ON CONFLICT (slug) DO NOTHING;
