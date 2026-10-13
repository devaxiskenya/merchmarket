-- Product content checks. Brands can write their own product rows straight through
-- the database API, so the server's field whitelist alone is not enough: these
-- checks stop markup or foreign links being stored where pages render them.

-- gradient is never set by the app any more (the frontend picks its own), so it stays empty.
alter table public.products drop constraint if exists products_gradient_unused;
alter table public.products add constraint products_gradient_unused check (gradient is null);

-- Every image must be a file in the brand's own folder of the product-images bucket.
create or replace function public.product_images_valid(p_images jsonb, p_brand uuid)
returns boolean language sql immutable set search_path = '' as $$
  select p_images is null or (
    jsonb_typeof(p_images) = 'array'
    and jsonb_array_length(p_images) <= 10
    and not exists (
      select 1 from jsonb_array_elements(p_images) e
      where coalesce(e->>'url', e #>> '{}', '') !~
        ('^https://omyzcnizwxumvookotsy\.supabase\.co/storage/v1/object/public/product-images/'
         || p_brand::text || '/[A-Za-z0-9._-]+$')
    )
  );
$$;

alter table public.products drop constraint if exists products_images_valid;
alter table public.products add constraint products_images_valid check (public.product_images_valid(images, brand_id));

-- Size guide measurements are numbers only.
create or replace function public.size_specs_valid(p_specs jsonb)
returns boolean language sql immutable set search_path = '' as $$
  select p_specs is null or (
    jsonb_typeof(p_specs) = 'array'
    and not exists (
      select 1 from jsonb_array_elements(p_specs) s
      where jsonb_typeof(s) <> 'object'
         or (s ? 'garment' and jsonb_typeof(s->'garment') <> 'object')
         or exists (select 1 from jsonb_each(coalesce(s->'garment', '{}'::jsonb)) g where jsonb_typeof(g.value) <> 'number')
    )
  );
$$;

alter table public.products drop constraint if exists products_size_specs_valid;
alter table public.products add constraint products_size_specs_valid check (public.size_specs_valid(size_specs));
