-- Do not certify rows parsed before the conservative v5 eligibility rules.
BEGIN;

UPDATE public.eligibility_rules AS e
   SET needs_review = true,
       review_reason = 'parser_v5_reingest_required'
  FROM public.programs AS p
  JOIN public.raw_documents AS r ON r.id = p.raw_document_id
 WHERE e.program_id = p.id
   AND p.status = 'active'
   AND r.content_hash NOT LIKE 'parser-v5:%';

COMMIT;
