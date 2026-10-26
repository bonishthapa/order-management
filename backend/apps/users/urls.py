from django.urls import path

from . import views

urlpatterns = [
    path("login/", views.login, name="auth-login"),
    path("refresh/", views.refresh, name="auth-refresh"),
    path("logout/", views.logout, name="auth-logout"),
    path("me/", views.me, name="auth-me"),
    path("change-password/", views.change_password, name="auth-change-password"),
    path("password-reset/", views.password_reset, name="auth-password-reset"),
    path("password-reset/confirm/", views.password_reset_confirm, name="auth-password-reset-confirm"),
]
