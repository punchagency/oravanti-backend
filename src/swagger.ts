import swaggerJsdoc from "swagger-jsdoc";

const options: swaggerJsdoc.Options = {
  definition: {
    openapi: "3.0.0",
    info: {
      title: "Oravanti API",
      version: "1.0.0",
      description:
        "Oravanti Backend API — immigration case management & law firm operations platform.",
    },
    servers: [
      {
        url: "/",
        description: "Current server",
      },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
        },
      },
      schemas: {
        Error: {
          type: "object",
          properties: {
            status: { type: "string" },
            message: { type: "string" },
          },
        },
        Pagination: {
          type: "object",
          properties: {
            data: { type: "array", items: { type: "object" } },
            total: { type: "integer" },
            page: { type: "integer" },
            limit: { type: "integer" },
            totalPages: { type: "integer" },
          },
        },
        MessageResponse: {
          type: "object",
          properties: {
            message: { type: "string" },
          },
        },

        Case: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            caseNumber: { type: "string" },
            clientId: { type: "string", format: "uuid" },
            practiceAreaId: { type: "string", format: "uuid" },
            caseType: { type: "string" },
            status: { type: "string", enum: ["active", "pending_review", "on_hold", "completed", "cancelled"] },
            priority: { type: "string", enum: ["low", "medium", "high", "critical"] },
            assignmentType: { type: "string" },
            teamId: { type: "string", format: "uuid" },
            assignedStaffId: { type: "string", format: "uuid" },
            requiredCertifications: { type: "array", items: { type: "string" } },
            caseProgress: { type: "integer" },
            filingDate: { type: "string", format: "date" },
            estimatedCompletionDate: { type: "string", format: "date" },
            nextAppointment: { type: "string", format: "date" },
            description: { type: "string" },
            notes: { type: "string" },
            currentEmployer: { type: "string" },
            createdByAdminId: { type: "string", format: "uuid" },
            createdByStaffId: { type: "string", format: "uuid" },
            createdAt: { type: "string", format: "date-time" },
            updatedAt: { type: "string", format: "date-time" },
          },
        },
        CreateCaseRequest: {
          type: "object",
          required: ["clientId", "practiceAreaId", "caseType", "filingDate", "description"],
          properties: {
            clientId: { type: "string", format: "uuid" },
            practiceAreaId: { type: "string", format: "uuid" },
            caseType: { type: "string" },
            filingDate: { type: "string", format: "date" },
            description: { type: "string" },
            notes: { type: "string" },
          },
        },
        UpdateCaseRequest: {
          type: "object",
          properties: {
            clientId: { type: "string", format: "uuid" },
            practiceAreaId: { type: "string", format: "uuid" },
            caseType: { type: "string" },
            status: { type: "string", enum: ["active", "pending_review", "on_hold", "completed", "cancelled"] },
            priority: { type: "string", enum: ["low", "medium", "high", "critical"] },
            description: { type: "string" },
            notes: { type: "string" },
          },
        },
        CaseNumberResponse: {
          type: "object",
          properties: {
            caseNumber: { type: "string" },
          },
        },

        Client: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            userId: { type: "string" },
            firstName: { type: "string" },
            middleName: { type: "string" },
            lastName: { type: "string" },
            secondLastName: { type: "string" },
            thirdLastName: { type: "string" },
            fourthLastName: { type: "string" },
            email: { type: "string", format: "email" },
            phone: { type: "string" },
            dateOfBirth: { type: "string", format: "date" },
            nationality: { type: "string" },
            countryOfOrigin: { type: "string" },
            passportNumber: { type: "string" },
            currentAddress: { type: "string" },
            clientType: { type: "string", enum: ["individual", "company_representative"] },
            companyId: { type: "string", format: "uuid" },
            status: { type: "string", enum: ["active", "inactive", "pending"] },
            createdAt: { type: "string", format: "date-time" },
            updatedAt: { type: "string", format: "date-time" },
          },
        },
        CreateClientRequest: {
          type: "object",
          required: ["client"],
          properties: {
            client: {
              type: "object",
              required: ["firstName", "lastName"],
              properties: {
                firstName: { type: "string" },
                lastName: { type: "string" },
                email: { type: "string", format: "email" },
                phoneNumber: { type: "string" },
                address: { type: "string" },
                dateOfBirth: { type: "string", format: "date" },
                passportNumber: { type: "string" },
              },
            },
            case: {
              type: "object",
              properties: {
                practiceAreaId: { type: "string", format: "uuid" },
                caseType: { type: "string" },
                description: { type: "string" },
              },
            },
          },
        },
        UpdateClientRequest: {
          type: "object",
          properties: {
            firstName: { type: "string" },
            lastName: { type: "string" },
            email: { type: "string", format: "email" },
            phoneNumber: { type: "string" },
            address: { type: "string" },
          },
        },

        Company: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            companyName: { type: "string" },
            companyType: { type: "string", enum: ["llc", "corporation", "s_corp", "partnership", "sole_proprietorship", "non_profit", "government", "other"] },
            ein: { type: "string" },
            industry: { type: "string" },
            numberOfEmployees: { type: "integer" },
            address: { type: "string" },
            city: { type: "string" },
            state: { type: "string" },
            zipCode: { type: "string" },
            country: { type: "string" },
            phone: { type: "string" },
            website: { type: "string" },
            primaryContactName: { type: "string" },
            primaryContactEmail: { type: "string", format: "email" },
            primaryContactPhone: { type: "string" },
            status: { type: "string", enum: ["active", "inactive", "dissolved"] },
            createdAt: { type: "string", format: "date-time" },
            updatedAt: { type: "string", format: "date-time" },
          },
        },
        CreateCompanyRequest: {
          type: "object",
          required: ["company"],
          properties: {
            company: {
              type: "object",
              required: ["name"],
              properties: {
                name: { type: "string" },
                address: { type: "string" },
                phoneNumber: { type: "string" },
              },
            },
            individuals: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  firstName: { type: "string" },
                  lastName: { type: "string" },
                  email: { type: "string", format: "email" },
                  caseData: {
                    type: "object",
                    properties: {
                      practiceAreaId: { type: "string", format: "uuid" },
                      caseType: { type: "string" },
                    },
                  },
                },
              },
            },
          },
        },
        UpdateCompanyRequest: {
          type: "object",
          properties: {
            name: { type: "string" },
            address: { type: "string" },
            phoneNumber: { type: "string" },
          },
        },
        AddClientToCompanyRequest: {
          type: "object",
          required: ["clientData"],
          properties: {
            clientData: {
              type: "object",
              required: ["firstName", "lastName"],
              properties: {
                firstName: { type: "string" },
                lastName: { type: "string" },
                email: { type: "string", format: "email" },
              },
            },
            caseData: {
              type: "object",
              properties: {
                practiceAreaId: { type: "string", format: "uuid" },
                caseType: { type: "string" },
              },
            },
          },
        },

        Task: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            title: { type: "string" },
            description: { type: "string" },
            caseId: { type: "string", format: "uuid" },
            teamId: { type: "string", format: "uuid" },
            assignedToId: { type: "string", format: "uuid" },
            assignedById: { type: "string", format: "uuid" },
            dueDate: { type: "string", format: "date" },
            priority: { type: "string", enum: ["low", "medium", "high", "critical"] },
            status: { type: "string", enum: ["pending", "in_progress", "completed", "cancelled"] },
            progress: { type: "integer" },
            requiredCertifications: { type: "array", items: { type: "string" } },
            createdAt: { type: "string", format: "date-time" },
            updatedAt: { type: "string", format: "date-time" },
          },
        },
        CreateTaskRequest: {
          type: "object",
          required: ["title", "description", "caseId", "assignedToId", "dueDate"],
          properties: {
            title: { type: "string" },
            description: { type: "string" },
            caseId: { type: "string", format: "uuid" },
            assignedToId: { type: "string", format: "uuid" },
            dueDate: { type: "string", format: "date" },
            priority: { type: "string", enum: ["low", "medium", "high"] },
          },
        },
        UpdateTaskRequest: {
          type: "object",
          properties: {
            title: { type: "string" },
            description: { type: "string" },
            status: { type: "string", enum: ["pending", "in_progress", "completed", "cancelled"] },
            priority: { type: "string", enum: ["low", "medium", "high", "critical"] },
            assignedToId: { type: "string", format: "uuid" },
            dueDate: { type: "string", format: "date" },
          },
        },
        TaskStats: {
          type: "object",
          properties: {
            activeTasks: { type: "integer" },
            completedThisWeek: { type: "integer" },
            highPriority: { type: "integer" },
            dueThisWeek: { type: "integer" },
          },
        },

        Document: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            clientId: { type: "string", format: "uuid" },
            caseId: { type: "string", format: "uuid" },
            uploadedById: { type: "string", format: "uuid" },
            name: { type: "string" },
            category: { type: "string", enum: ["application", "supporting", "identity", "uscis_response"] },
            fileUrl: { type: "string" },
            fileSize: { type: "integer" },
            mimeType: { type: "string" },
            status: { type: "string", enum: ["approved", "review_needed", "processing"] },
            aiChecked: { type: "boolean" },
            createdAt: { type: "string", format: "date-time" },
            updatedAt: { type: "string", format: "date-time" },
          },
        },
        UpdateDocumentStatusRequest: {
          type: "object",
          required: ["status"],
          properties: {
            status: { type: "string", enum: ["approved", "review_needed", "processing"] },
          },
        },
        SignedUrlResponse: {
          type: "object",
          properties: {
            url: { type: "string" },
          },
        },

        CalendarEvent: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            eventType: { type: "string", enum: ["master_calendar_hearing", "individual_hearing", "uscis_interview", "biometric", "filing_deadline", "service_request", "client_meeting", "internal_event"] },
            status: { type: "string", enum: ["scheduled", "completed", "cancelled"] },
            title: { type: "string" },
            startTime: { type: "string", format: "date-time" },
            endTime: { type: "string", format: "date-time" },
            clientId: { type: "string", format: "uuid" },
            caseId: { type: "string", format: "uuid" },
            assignedStaffId: { type: "string", format: "uuid" },
            teamId: { type: "string", format: "uuid" },
            location: { type: "string" },
            zoomLink: { type: "string" },
            notes: { type: "string" },
            isAutoGenerated: { type: "boolean" },
            filingSubmittedDate: { type: "string", format: "date" },
            detained: { type: "boolean" },
            judgeDeadlineType: { type: "string", enum: ["30_days_before", "60_days_before", "custom"] },
            customDeadlineDate: { type: "string", format: "date" },
            removabilityFindingDate: { type: "string", format: "date" },
            createdAt: { type: "string", format: "date-time" },
            updatedAt: { type: "string", format: "date-time" },
          },
        },
        CreateCalendarEventRequest: {
          type: "object",
          required: ["title", "startTime", "endTime", "type"],
          properties: {
            title: { type: "string" },
            description: { type: "string" },
            startTime: { type: "string", format: "date-time" },
            endTime: { type: "string", format: "date-time" },
            type: { type: "string" },
            caseId: { type: "string", format: "uuid" },
            clientId: { type: "string", format: "uuid" },
            assignedToId: { type: "string", format: "uuid" },
            teamId: { type: "string", format: "uuid" },
          },
        },
        UpdateCalendarEventRequest: {
          type: "object",
          properties: {
            title: { type: "string" },
            description: { type: "string" },
            startTime: { type: "string", format: "date-time" },
            endTime: { type: "string", format: "date-time" },
            type: { type: "string" },
          },
        },
        CreateServiceRequestRequest: {
          type: "object",
          required: ["clientId", "caseId", "clientName", "formType"],
          properties: {
            clientId: { type: "string", format: "uuid" },
            caseId: { type: "string", format: "uuid" },
            clientName: { type: "string" },
            formType: { type: "string" },
            assignedStaffId: { type: "string", format: "uuid" },
            teamId: { type: "string", format: "uuid" },
          },
        },

        PracticeArea: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            name: { type: "string" },
            createdAt: { type: "string", format: "date-time" },
            updatedAt: { type: "string", format: "date-time" },
          },
        },
        PracticeAreaCaseType: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            practiceAreaId: { type: "string", format: "uuid" },
            code: { type: "string" },
            name: { type: "string" },
            caseNumberPrefix: { type: "string" },
          },
        },
        Subscription: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            practiceAreaId: { type: "string", format: "uuid" },
            status: { type: "string", enum: ["active", "past_due", "cancelled", "expired"] },
            billingCycle: { type: "string" },
            startsAt: { type: "string", format: "date-time" },
            expiresAt: { type: "string", format: "date-time" },
            cancelledAt: { type: "string", format: "date-time" },
            paymentProvider: { type: "string" },
            providerSubscriptionId: { type: "string" },
            createdAt: { type: "string", format: "date-time" },
          },
        },
        CreateSubscriptionRequest: {
          type: "object",
          required: ["practiceAreaIds"],
          properties: {
            practiceAreaIds: { type: "array", items: { type: "string", format: "uuid" } },
          },
        },
        CancelSubscriptionRequest: {
          type: "object",
          properties: {
            subscriptionIds: { type: "array", items: { type: "string", format: "uuid" } },
            practiceAreaIds: { type: "array", items: { type: "string", format: "uuid" } },
          },
        },
        FirmPracticeArea: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            practiceAreaId: { type: "string", format: "uuid" },
            subscriptionId: { type: "string", format: "uuid" },
            active: { type: "boolean" },
            createdAt: { type: "string", format: "date-time" },
          },
        },

        Staff: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            userId: { type: "string" },
            firstName: { type: "string" },
            lastName: { type: "string" },
            email: { type: "string", format: "email" },
            phone: { type: "string" },
            role: { type: "string", enum: ["admin", "attorney", "senior_paralegal", "paralegal", "junior_paralegal"] },
            status: { type: "string", enum: ["active", "inactive", "on_leave"] },
            maxCaseload: { type: "integer" },
            startDate: { type: "string", format: "date" },
            performanceScore: { type: "integer" },
            certificationsCount: { type: "integer" },
            activeCases: { type: "integer" },
            totalCases: { type: "integer" },
            monthlySalary: { type: "string" },
            hourlyRate: { type: "string" },
            avatarUrl: { type: "string" },
            createdAt: { type: "string", format: "date-time" },
            updatedAt: { type: "string", format: "date-time" },
          },
        },
        CreateStaffRequest: {
          type: "object",
          required: ["firstName", "lastName", "email", "phone", "role", "startDate"],
          properties: {
            firstName: { type: "string" },
            lastName: { type: "string" },
            email: { type: "string", format: "email" },
            phone: { type: "string" },
            role: { type: "string", enum: ["admin", "attorney", "paralegal", "senior_paralegal", "contractor"] },
            teamId: { type: "string", format: "uuid" },
            startDate: { type: "string", format: "date" },
          },
        },
        UpdateStaffRequest: {
          type: "object",
          properties: {
            firstName: { type: "string" },
            lastName: { type: "string" },
            email: { type: "string", format: "email" },
            phone: { type: "string" },
            role: { type: "string" },
            teamId: { type: "string", format: "uuid" },
          },
        },

        Team: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            name: { type: "string" },
            leadId: { type: "string", format: "uuid" },
            description: { type: "string" },
            maxCaseload: { type: "integer" },
            workloadPercentage: { type: "integer" },
            status: { type: "string", enum: ["available", "full", "overloaded"] },
            activeCases: { type: "integer" },
            createdAt: { type: "string", format: "date-time" },
            updatedAt: { type: "string", format: "date-time" },
          },
        },
        CreateTeamRequest: {
          type: "object",
          required: ["name"],
          properties: {
            name: { type: "string" },
            leadId: { type: "string", format: "uuid" },
            description: { type: "string" },
          },
        },
        UpdateTeamRequest: {
          type: "object",
          properties: {
            name: { type: "string" },
            leadId: { type: "string", format: "uuid" },
            description: { type: "string" },
          },
        },

        Assignment: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            caseId: { type: "string", format: "uuid" },
            assignmentType: { type: "string", enum: ["internal_team", "external_contractor"] },
            filingType: { type: "string", enum: ["I-130", "I-485", "I-765", "I-140", "N-400", "I-131"] },
            urgencyLevel: { type: "string", enum: ["normal", "urgent", "critical"] },
            status: { type: "string", enum: ["pending", "active", "completed", "cancelled"] },
            teamId: { type: "string", format: "uuid" },
            assignedStaffId: { type: "string", format: "uuid" },
            contractorId: { type: "string", format: "uuid" },
            createdAt: { type: "string", format: "date-time" },
            updatedAt: { type: "string", format: "date-time" },
          },
        },
        CreateAssignmentRequest: {
          type: "object",
          required: ["caseId", "assignmentType", "filingType", "urgencyLevel"],
          properties: {
            caseId: { type: "string", format: "uuid" },
            assignmentType: { type: "string", enum: ["internal_team", "external_contractor"] },
            teamId: { type: "string", format: "uuid" },
            contractorId: { type: "string", format: "uuid" },
            filingType: { type: "string", enum: ["I-130", "I-485", "I-765", "I-140", "N-400", "I-131"] },
            urgencyLevel: { type: "string", enum: ["low", "medium", "high"] },
            notes: { type: "string" },
          },
        },
        UpdateAssignmentStatusRequest: {
          type: "object",
          required: ["status"],
          properties: {
            status: { type: "string", enum: ["pending", "active", "completed", "cancelled"] },
          },
        },

        Contractor: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            name: { type: "string" },
            email: { type: "string", format: "email" },
            specialization: { type: "string" },
            status: { type: "string", enum: ["active", "inactive", "pending"] },
            rate: { type: "string" },
            contractStart: { type: "string", format: "date" },
            contractEnd: { type: "string", format: "date" },
            createdAt: { type: "string", format: "date-time" },
          },
        },

        AiErrorFlag: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            clientId: { type: "string", format: "uuid" },
            caseId: { type: "string", format: "uuid" },
            documentId: { type: "string", format: "uuid" },
            title: { type: "string" },
            description: { type: "string" },
            severity: { type: "string", enum: ["critical", "high", "medium", "low"] },
            status: { type: "string", enum: ["pending_review", "under_review", "resolved"] },
            affectedField: { type: "string" },
            documentRef: { type: "string" },
            resolvedById: { type: "string", format: "uuid" },
            resolvedAt: { type: "string", format: "date-time" },
            createdAt: { type: "string", format: "date-time" },
            updatedAt: { type: "string", format: "date-time" },
          },
        },
        CreateAiErrorFlagRequest: {
          type: "object",
          required: ["clientId", "caseId", "title", "description", "severity"],
          properties: {
            clientId: { type: "string", format: "uuid" },
            caseId: { type: "string", format: "uuid" },
            title: { type: "string" },
            description: { type: "string" },
            severity: { type: "string", enum: ["low", "medium", "high", "critical"] },
          },
        },
        UpdateFlagStatusRequest: {
          type: "object",
          required: ["status"],
          properties: {
            status: { type: "string" },
          },
        },
        AiErrorDetectionStats: {
          type: "object",
          properties: {
            errorsDetectedThisMonth: { type: "integer" },
            errorsPrevented: { type: "integer" },
            avgDetectionTime: { type: "string" },
            errorRateReduction: { type: "string" },
          },
        },
        AiSystemConfig: {
          type: "object",
          properties: {
            isActive: { type: "boolean" },
            crossCheckingEnabled: { type: "boolean" },
            inaValidationActive: { type: "boolean" },
            realtimeAnalysis: { type: "boolean" },
          },
        },
        UpdateAiSystemConfigRequest: {
          type: "object",
          properties: {
            enabled: { type: "boolean" },
            sensitivity: { type: "string" },
          },
        },

        ClientRequest: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            clientId: { type: "string", format: "uuid" },
            caseId: { type: "string", format: "uuid" },
            description: { type: "string" },
            requestedAt: { type: "string", format: "date" },
            status: { type: "string", enum: ["pending", "fulfilled"] },
            createdAt: { type: "string", format: "date-time" },
          },
        },
        AddClientRequestItem: {
          type: "object",
          properties: {
            requestType: { type: "string" },
            description: { type: "string" },
          },
        },
        AddClientRequestsRequest: {
          type: "object",
          required: ["caseId", "items"],
          properties: {
            caseId: { type: "string", format: "uuid" },
            items: { type: "array", items: { $ref: "#/components/schemas/AddClientRequestItem" } },
          },
        },
        ResponsivenessStats: {
          type: "object",
          properties: {
            responsive: { type: "integer" },
            at_risk: { type: "integer" },
            unresponsive: { type: "integer" },
            critical: { type: "integer" },
          },
        },

        RevenueAnalyticsResponse: {
          type: "object",
          properties: {
            summary: { type: "object" },
            charts: { type: "object" },
            staffMetrics: { type: "array", items: { type: "object" } },
          },
        },

        Profile: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            userId: { type: "string" },
            firstName: { type: "string" },
            lastName: { type: "string" },
            email: { type: "string", format: "email" },
            phone: { type: "string" },
            jobTitle: { type: "string" },
            barNumber: { type: "string" },
            avatarUrl: { type: "string" },
            createdAt: { type: "string", format: "date-time" },
            updatedAt: { type: "string", format: "date-time" },
          },
        },
        UpdateProfileRequest: {
          type: "object",
          properties: {
            firstName: { type: "string" },
            lastName: { type: "string" },
            phoneNumber: { type: "string" },
            timezone: { type: "string" },
          },
        },

        ModulePermission: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            module: { type: "string" },
            role: { type: "string" },
            permission: { type: "string" },
          },
        },
        SavePermissionsRequest: {
          type: "object",
          required: ["permissions"],
          properties: {
            permissions: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  module: { type: "string" },
                  role: { type: "string" },
                  canAccess: { type: "boolean" },
                  canCreate: { type: "boolean" },
                  canEdit: { type: "boolean" },
                  canDelete: { type: "boolean" },
                },
              },
            },
          },
        },
        ParalegalCertificationGate: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            action: { type: "string" },
            actionLabel: { type: "string" },
            requiredCertifications: { type: "array", items: { type: "string" } },
          },
        },
        UpdateCertificationGatesRequest: {
          type: "object",
          required: ["gates"],
          properties: {
            gates: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  actionType: { type: "string" },
                  requiredCertifications: { type: "array", items: { type: "string" } },
                },
              },
            },
          },
        },
        ParalegalActivationRequirement: {
          type: "object",
          properties: {
            certificationCode: { type: "string" },
          },
        },
        UpdateActivationRequirementsRequest: {
          type: "object",
          required: ["certificationCodes"],
          properties: {
            certificationCodes: { type: "array", items: { type: "string" } },
          },
        },

        DataAccessControl: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            dataType: { type: "string" },
            role: { type: "string" },
            permission: { type: "string" },
          },
        },
        UpdateDataAccessRequest: {
          type: "object",
          properties: {
            dataType: { type: "string" },
            role: { type: "string" },
            permission: { type: "string" },
          },
        },

        FinancialAccessControl: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            accountType: { type: "string", enum: ["operating", "trust_iolta"] },
            role: { type: "string" },
            permission: { type: "string" },
          },
        },
        UpdateFinancialAccessRequest: {
          type: "object",
          properties: {
            accountType: { type: "string" },
            role: { type: "string" },
            permission: { type: "string" },
          },
        },

        PermissionAuditLogEntry: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            action: { type: "string" },
            changedBy: { type: "string", format: "uuid" },
            changedByName: { type: "string" },
            changedByRole: { type: "string" },
            createdAt: { type: "string", format: "date-time" },
          },
        },

        ApprovalWorkflow: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            workflowType: { type: "string", enum: ["case_submission", "document_upload", "payment_processing", "client_addition", "staff_certification"] },
            chain: { type: "string" },
            isRequired: { type: "boolean" },
            allowBypass: { type: "boolean" },
          },
        },
        UpdateApprovalWorkflowRequest: {
          type: "object",
          properties: {
            chain: { type: "string" },
            isRequired: { type: "boolean" },
            allowBypass: { type: "boolean" },
          },
        },

        Certification: {
          type: "object",
          properties: {
            code: { type: "string" },
            name: { type: "string" },
            level: { type: "string", enum: ["basic", "intermediate", "advanced", "expert"] },
            description: { type: "string" },
          },
        },

        TwoFactorStatus: {
          type: "object",
          properties: {
            enabled: { type: "boolean" },
          },
        },

        ChangePasswordRequest: {
          type: "object",
          required: ["currentPassword", "newPassword"],
          properties: {
            currentPassword: { type: "string" },
            newPassword: { type: "string", minLength: 8 },
          },
        },

        OrganizationInviteRequest: {
          type: "object",
          required: ["firstName", "lastName", "email", "role"],
          properties: {
            firstName: { type: "string" },
            lastName: { type: "string" },
            email: { type: "string", format: "email" },
            phoneNumber: { type: "string" },
            role: { type: "string", enum: ["admin", "attorney", "paralegal", "contractor"] },
            maxCaseLoad: { type: "integer" },
            startDate: { type: "string", format: "date" },
          },
        },
        AcceptInvitationRequest: {
          type: "object",
          required: ["invitationId"],
          properties: {
            invitationId: { type: "string" },
          },
        },
        Invitation: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            email: { type: "string", format: "email" },
            role: { type: "string" },
            status: { type: "string" },
            createdAt: { type: "string", format: "date-time" },
          },
        },

        SignUpRequest: {
          type: "object",
          required: ["email", "password"],
          properties: {
            email: { type: "string", format: "email" },
            password: { type: "string", minLength: 8 },
            rememberMe: { type: "boolean" },
          },
        },
        SignInRequest: {
          type: "object",
          required: ["email", "password"],
          properties: {
            email: { type: "string", format: "email" },
            password: { type: "string" },
            rememberMe: { type: "boolean" },
          },
        },
        VerifyTotpRequest: {
          type: "object",
          required: ["code"],
          properties: {
            code: { type: "string" },
          },
        },
        SendOtpRequest: {
          type: "object",
          required: ["email", "type"],
          properties: {
            email: { type: "string", format: "email" },
            type: { type: "string", enum: ["email_verification", "password_reset"] },
          },
        },
        ResetPasswordRequest: {
          type: "object",
          required: ["email", "otp", "password"],
          properties: {
            email: { type: "string", format: "email" },
            otp: { type: "string" },
            password: { type: "string" },
          },
        },
        RevokeSessionRequest: {
          type: "object",
          required: ["token"],
          properties: {
            token: { type: "string" },
          },
        },
        EnableTwoFactorRequest: {
          type: "object",
          required: ["password"],
          properties: {
            password: { type: "string" },
          },
        },

        SessionInfo: {
          type: "object",
          properties: {
            id: { type: "string" },
            userId: { type: "string" },
            email: { type: "string", format: "email" },
            createdAt: { type: "string", format: "date-time" },
            expiresAt: { type: "string", format: "date-time" },
          },
        },
        UserSessionResponse: {
          type: "object",
          properties: {
            user: { type: "object" },
            session: { $ref: "#/components/schemas/SessionInfo" },
          },
        },
        TotpVerifiedResponse: {
          type: "object",
          properties: {
            token: { type: "string" },
            user: { type: "object" },
          },
        },

        FirmInfo: {
          type: "object",
          properties: {
            firmName: { type: "string" },
            firmEmail: { type: "string", format: "email" },
            firmPhone: { type: "string" },
            firmAddress: { type: "string" },
            firmLogo: { type: "string" },
          },
        },
        UpdateFirmInfoRequest: {
          type: "object",
          properties: {
            firmName: { type: "string" },
            firmEmail: { type: "string", format: "email" },
            firmPhone: { type: "string" },
            firmAddress: { type: "string" },
          },
        },
      },
    },
  },
  apis: ["./src/resources/**/*.routes.ts"],
};

const spec = swaggerJsdoc(options) as {
  paths?: Record<string, Record<string, { operationId?: string }>>;
};

export const swaggerSpec = spec;
