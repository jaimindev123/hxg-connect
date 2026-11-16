import { Controller, Get, Module } from '@nestjs/common';
import { Db } from './db/db.service';
import { PlatformGuard, TenantGuard } from './common/guards';
import { Storage } from './common/storage';
import { ProvisioningService } from './platform/provisioning.service';
import {
  ImpersonationController, PlansController, PlatformAuthController, PlatformMeController, PlatformOverviewController,
  PlatformUsersController, TenantsController,
} from './platform/platform.controllers';
import {
  MeController, SupportAccessController, TenantAuthController, UsersController,
} from './tenant/workspace.controllers';
import { LeadsController } from './tenant/leads.controller';
import {
  DashboardController, FollowUpsController, PipelinesController, UserAdminController,
} from './tenant/crm.controllers';
import { FieldController, FilesController } from './tenant/field.controller';
import { IntegrationsService, Mailer, PlatformSettings } from './integrations/integrations.service';
import {
  BookingsController, HoldSweeper, ProjectsController, SiteVisitsController, UnitsController,
} from './tenant/inventory.controllers';
import {
  ApiKeysController, AssignmentRulesController, CaptureController, ImportController,
} from './tenant/capture.controllers';
import { CallsController, CallWebhooksController, PasswordController, ProfileController, WhatsAppController } from './comms/comms.controllers';
import { ReportsController } from './tenant/reports.controller';
import { PortalIntake, PortalReviewController, PortalWebhooksController } from './tenant/portals';
import { ConnectorSetupController, ConnectorWebhooksController } from './tenant/connectors';
import { BillingScheduler, BillingService, PlatformBillingController, PlatformBillingWebhookController, TenantBillingController } from './platform/billing';
import { CommissionsController, PartnerAuthController, PartnerPortalController, StaffPartnersController } from './tenant/partners.controllers';
import {
  PlatformIntegrationsController, PlatformSettingsController, PublicConfigController,
  TenantIntegrationsController, WebhooksController,
} from './integrations/integrations.controllers';

@Controller('health')
class HealthController {
  constructor(private readonly db: Db) {}
  @Get()
  async health() {
    await this.db.platform('SELECT 1');
    await this.db.appNoTenant('SELECT 1');
    return { ok: true };
  }
}

@Module({
  controllers: [
    HealthController,
    // platform plane
    PlatformAuthController, PlatformMeController, PlatformUsersController, PlatformOverviewController,
    PlansController, TenantsController, ImpersonationController,
    // tenant plane
    TenantAuthController, MeController, UserAdminController, UsersController, SupportAccessController,
    LeadsController, PipelinesController, FollowUpsController, DashboardController,
    FieldController, FilesController, TenantIntegrationsController,
    ProjectsController, UnitsController, SiteVisitsController, BookingsController,
    AssignmentRulesController, ApiKeysController, CaptureController, ImportController,
    ProfileController, PasswordController, CallsController, CallWebhooksController, WhatsAppController, ReportsController,
    StaffPartnersController, CommissionsController, PartnerAuthController, PartnerPortalController,
    PlatformBillingController, TenantBillingController, PlatformBillingWebhookController,
    PortalWebhooksController, PortalReviewController, ConnectorWebhooksController, ConnectorSetupController,
    // integrations, settings, public
    PlatformIntegrationsController, PlatformSettingsController, PublicConfigController, WebhooksController,
  ],
  providers: [Db, Storage, ProvisioningService, PlatformGuard, TenantGuard, IntegrationsService, PlatformSettings, Mailer, HoldSweeper, BillingService, BillingScheduler, PortalIntake],
})
export class AppModule {}
