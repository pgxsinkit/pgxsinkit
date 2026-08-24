CREATE TABLE "projection_key_rows" (
	"id" uuid,
	"owner_id" uuid,
	"value" varchar(120) NOT NULL,
	CONSTRAINT "projection_key_rows_pkey" PRIMARY KEY("id","owner_id")
);
