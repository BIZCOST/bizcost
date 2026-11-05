-- Removes one feedback, for a request under the privacy policy (docs/ARCHITECTURE.md §Runbooks › "A
-- person's request"). Supabase → SQL Editor, as postgres: put its id on the line marked below, then run
-- it. Find the id with:
--   select id, created_at, left(message, 80), image_path from app.feedback order by created_at desc;
--
-- A row deleted by itself would vanish from /platform and leave its picture in Storage for good, with
-- nothing pointing at it, and SQL cannot delete the picture. So this stops while the picture is there
-- and says where it is: delete it in Supabase → Storage → business-files, then run this again. The copy
-- emailed to the owner goes by hand, from his mailbox.

do $$
declare
  v_feedback constant uuid := '00000000-0000-0000-0000-000000000000'; -- ← the feedback's id
  v_picture text;
begin
  if not exists (select 1 from app.feedback f where f.id = v_feedback) then
    raise exception 'no feedback has the id %', v_feedback;
  end if;
  select f.image_path into v_picture
  from app.feedback f
  join storage.objects o on o.bucket_id = 'business-files' and o.name = f.image_path
  where f.id = v_feedback;
  if v_picture is not null then
    raise exception 'delete its picture first: % in Storage', v_picture;
  end if;
  delete from app.feedback f where f.id = v_feedback;
end
$$;
