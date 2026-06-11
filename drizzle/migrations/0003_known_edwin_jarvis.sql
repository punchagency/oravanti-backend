CREATE TABLE "contractor_identification_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contractor_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"verification_status" "contractor_certification_verification_status" DEFAULT 'pending' NOT NULL,
	"reviewed_by_user_id" text,
	"reviewed_at" timestamp,
	"rejection_reason" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "contractor_identification_documents" ADD CONSTRAINT "contractor_identification_documents_contractor_id_contractors_id_fk" FOREIGN KEY ("contractor_id") REFERENCES "public"."contractors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contractor_identification_documents" ADD CONSTRAINT "contractor_identification_documents_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contractor_identification_documents" ADD CONSTRAINT "contractor_identification_documents_reviewed_by_user_id_user_id_fk" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "contractor_identification_documents_document_uidx" ON "contractor_identification_documents" USING btree ("document_id");--> statement-breakpoint
CREATE UNIQUE INDEX "contractor_identification_documents_position_uidx" ON "contractor_identification_documents" USING btree ("contractor_id","position");--> statement-breakpoint
CREATE INDEX "contractor_identification_documents_contractor_idx" ON "contractor_identification_documents" USING btree ("contractor_id");--> statement-breakpoint
CREATE INDEX "contractor_identification_documents_status_idx" ON "contractor_identification_documents" USING btree ("verification_status");