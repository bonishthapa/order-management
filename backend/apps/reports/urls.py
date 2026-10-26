from django.urls import path

from . import views

urlpatterns = [
    path("", views.report_index, name="report-index"),
    path("dashboard/", views.dashboard, name="dashboard"),
    path("<slug:slug>/", views.report_detail, name="report-detail"),
]
