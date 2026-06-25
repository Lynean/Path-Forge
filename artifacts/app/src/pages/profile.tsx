import { useState, useEffect } from "react";
import { useGetProfile, useUpsertProfile } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";

export default function Profile() {
  const { data: profile, isLoading } = useGetProfile();
  const upsertProfile = useUpsertProfile();
  const { toast } = useToast();

  const [formData, setFormData] = useState({
    age: "",
    educationLevel: "",
    major: "",
    interests: "",
    experience: ""
  });

  useEffect(() => {
    if (profile) {
      setFormData({
        age: profile.age?.toString() || "",
        educationLevel: profile.educationLevel || "",
        major: profile.major || "",
        interests: profile.interests || "",
        experience: profile.experience || ""
      });
    }
  }, [profile]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    upsertProfile.mutate(
      {
        data: {
          age: formData.age ? parseInt(formData.age, 10) : null,
          educationLevel: formData.educationLevel || null,
          major: formData.major || null,
          interests: formData.interests,
          experience: formData.experience,
          isComplete: true
        }
      },
      {
        onSuccess: () => {
          toast({ title: "Profile updated" });
        }
      }
    );
  };

  if (isLoading) {
    return <div className="p-10 text-center text-muted-foreground">Loading profile...</div>;
  }

  return (
    <div className="p-6 md:p-10 max-w-3xl mx-auto">
      <h1 className="text-3xl font-mono font-bold tracking-tight mb-8">Learner Profile</h1>
      <form onSubmit={handleSubmit} className="space-y-6">
        <div className="grid md:grid-cols-2 gap-6">
          <div className="space-y-2">
            <Label htmlFor="age">Age</Label>
            <Input id="age" type="number" value={formData.age} onChange={(e) => setFormData({ ...formData, age: e.target.value })} />
          </div>
          <div className="space-y-2">
            <Label>Education Level</Label>
            <Select value={formData.educationLevel} onValueChange={(val) => setFormData({ ...formData, educationLevel: val })}>
              <SelectTrigger>
                <SelectValue placeholder="Select level" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="High School">High School</SelectItem>
                <SelectItem value="Bachelor's">Bachelor's</SelectItem>
                <SelectItem value="Master's">Master's</SelectItem>
                <SelectItem value="PhD">PhD</SelectItem>
                <SelectItem value="Self-taught">Self-taught</SelectItem>
                <SelectItem value="Other">Other</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        
        <div className="space-y-2">
          <Label htmlFor="major">Major / Field</Label>
          <Input id="major" value={formData.major} onChange={(e) => setFormData({ ...formData, major: e.target.value })} />
        </div>

        <div className="space-y-2">
          <Label htmlFor="interests">Interests</Label>
          <Textarea 
            id="interests" 
            value={formData.interests}
            onChange={(e) => setFormData({ ...formData, interests: e.target.value })}
            className="min-h-[120px]"
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="experience">Experience</Label>
          <Textarea 
            id="experience" 
            value={formData.experience}
            onChange={(e) => setFormData({ ...formData, experience: e.target.value })}
            className="min-h-[120px]"
          />
        </div>

        <div className="flex justify-end pt-4 border-t border-border">
          <Button type="submit" disabled={upsertProfile.isPending}>
            {upsertProfile.isPending ? "Saving..." : "Save Profile"}
          </Button>
        </div>
      </form>
    </div>
  );
}
