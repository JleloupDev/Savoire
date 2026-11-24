-- Portee d'un lien vers une page (voir ShareScope) : 'subpages' par defaut
-- pour les nouveaux liens ; les liens deja donnes restent sur leur page seule
-- (on n'elargit pas en silence ce qu'ils ouvrent).
ALTER TABLE share_links ADD COLUMN scope text NOT NULL DEFAULT 'page';

-- Les pages d'un lien « page et pages liees », fixees a sa creation.
CREATE TABLE share_link_documents (
    link_id text NOT NULL,
    doc_id text NOT NULL,
    PRIMARY KEY (link_id, doc_id)
);
CREATE INDEX ix_share_link_documents_doc ON share_link_documents (doc_id);
